// Maps QBO entities to and from the neutral form.
import { decimal, toMoney } from '../money.js'
import type {
  QboAccount,
  QboCustomer,
  QboInvoice,
  QboItem,
  QboPayment,
  QboSalesLine,
} from '../qbo/entities.js'
import { sortAllocations } from './neutral.js'
import type {
  NeutralAccount,
  NeutralCustomer,
  NeutralInvoice,
  NeutralItem,
  NeutralLine,
  NeutralPayment,
  ToLink,
  ToSide,
} from './neutral.js'

export type Unsupported = { unsupported: string }

const DELETED_SUFFIX = ' (deleted)'

// QBO marks a void with a note, not a flag
const hasVoidNote = (note: string | undefined): boolean => (note ?? '').startsWith('Voided')

// a void zeroes the payment and drops its lines; QBO keeps the record
export const isVoidedPayment = (p: QboPayment): boolean =>
  p.TotalAmt === 0 && p.Line.length === 0 && hasVoidNote(p.PrivateNote)

// deactivating a customer, account or item renames it
const originalName = (name: string, active: boolean): string =>
  !active && name.endsWith(DELETED_SUFFIX) ? name.slice(0, -DELETED_SUFFIX.length) : name

const isSalesLine = (l: QboInvoice['Line'][number]): l is QboSalesLine =>
  l.DetailType === 'SalesItemLineDetail'

// why the invoice has no neutral form, or null when it has one
export function unsupportedInvoice(i: QboInvoice): string | null {
  if (i.CurrencyRef.value !== 'USD') return `currency ${i.CurrencyRef.value} is not supported`
  if (!i.DocNumber) return 'invoice has no number'
  const line = i.Line.find(
    (l) => l.DetailType === 'DescriptionOnly' || l.DetailType === 'DiscountLineDetail'
  )
  return line ? `${line.DetailType} lines are not supported` : null
}

const ref = (value: string) => ({ value })

const salesLine = (l: NeutralLine, toSide: ToSide) => ({
  Amount: Number(l.amount),
  ...(l.description !== null && { Description: l.description }),
  DetailType: 'SalesItemLineDetail' as const,
  SalesItemLineDetail: {
    ItemRef: ref(toSide(l.item)),
    Qty: Number(l.quantity),
    UnitPrice: Number(l.unitPrice),
  },
})

const paymentLines = (allocations: NeutralPayment['allocations'], toSide: ToSide) =>
  allocations.map((a) => ({
    Amount: Number(a.amount),
    LinkedTxn: [{ TxnId: toSide(a.invoice), TxnType: 'Invoice' as const }],
  }))

export const qboToNeutral = {
  account: (a: QboAccount): NeutralAccount => ({
    name: originalName(a.Name, a.Active),
    active: a.Active,
  }),

  item: (i: QboItem, toLink: ToLink): NeutralItem | Unsupported => {
    if (i.Type === 'Inventory') return { unsupported: 'inventory items are not supported' }
    if (!i.IncomeAccountRef) return { unsupported: 'item has no income account' }
    return {
      name: originalName(i.Name, i.Active),
      incomeAccount: toLink('account', i.IncomeAccountRef.value),
      active: i.Active,
    }
  },

  customer: (c: QboCustomer): NeutralCustomer => ({
    name: originalName(c.DisplayName, c.Active),
    active: c.Active,
  }),

  invoice: (i: QboInvoice, toLink: ToLink): NeutralInvoice | Unsupported => {
    const reason = unsupportedInvoice(i)
    if (reason !== null) return { unsupported: reason }
    const sales = i.Line.filter(isSalesLine)
    return {
      number: i.DocNumber!, // checked by unsupportedInvoice
      customer: toLink('customer', i.CustomerRef.value),
      issueDate: i.TxnDate,
      dueDate: i.DueDate ?? i.TxnDate,
      memo: i.CustomerMemo?.value || null,
      lines: sales.map((l) => ({
        item: toLink('item', l.SalesItemLineDetail.ItemRef.value),
        description: l.Description ?? null,
        quantity: decimal(l.SalesItemLineDetail.Qty ?? 1),
        unitPrice: toMoney(l.SalesItemLineDetail.UnitPrice ?? l.Amount),
        amount: toMoney(l.Amount),
      })),
      tax: toMoney(i.TxnTaxDetail?.TotalTax ?? 0),
      voided: sales.every((l) => l.Amount === 0) && hasVoidNote(i.PrivateNote),
    }
  },

  payment: (p: QboPayment, toLink: ToLink): NeutralPayment => ({
    customer: toLink('customer', p.CustomerRef.value),
    date: p.TxnDate,
    amount: toMoney(p.TotalAmt),
    allocations: sortAllocations(
      p.Line.flatMap((l) => {
        const links = l.LinkedTxn.filter((t) => t.TxnType === 'Invoice')
        // a line linked to several invoices applies nothing
        return links.length === 1
          ? [{ invoice: toLink('invoice', links[0]!.TxnId), amount: toMoney(l.Amount) }]
          : []
      })
    ),
  }),
}

export const neutralToQbo = {
  customerCreate: (n: NeutralCustomer) => ({ DisplayName: n.name }),

  accountCreate: (n: NeutralAccount) => ({ Name: n.name, AccountType: 'Income' as const }),

  itemCreate: (n: NeutralItem, toSide: ToSide) => ({
    Name: n.name,
    Type: 'Service' as const,
    IncomeAccountRef: ref(toSide(n.incomeAccount)),
  }),

  invoiceCreate: (n: NeutralInvoice, toSide: ToSide) => ({
    DocNumber: n.number,
    CustomerRef: ref(toSide(n.customer)),
    TxnDate: n.issueDate,
    DueDate: n.dueDate,
    ...(n.memo !== null && { CustomerMemo: { value: n.memo } }),
    Line: n.lines.map((l) => salesLine(l, toSide)),
  }),

  paymentCreate: (n: NeutralPayment, toSide: ToSide) => ({
    CustomerRef: ref(toSide(n.customer)),
    TotalAmt: Number(n.amount),
    TxnDate: n.date,
    Line: paymentLines(n.allocations, toSide),
  }),

  customerPatch: (changes: Partial<NeutralCustomer>) => ({
    ...(changes.name !== undefined && { DisplayName: changes.name }),
    ...(changes.active !== undefined && { Active: changes.active }),
  }),

  accountPatch: (changes: Partial<NeutralAccount>) => ({
    ...(changes.name !== undefined && { Name: changes.name }),
    ...(changes.active !== undefined && { Active: changes.active }),
  }),

  itemPatch: (changes: Partial<NeutralItem>, toSide: ToSide) => ({
    ...(changes.name !== undefined && { Name: changes.name }),
    ...(changes.incomeAccount !== undefined && {
      IncomeAccountRef: ref(toSide(changes.incomeAccount)),
    }),
    ...(changes.active !== undefined && { Active: changes.active }),
  }),

  // void is an operation, not a field, so `voided` is never patched
  invoicePatch: (changes: Partial<NeutralInvoice>, current: QboInvoice, toSide: ToSide) => ({
    ...(changes.number !== undefined && { DocNumber: changes.number }),
    ...(changes.customer !== undefined && { CustomerRef: ref(toSide(changes.customer)) }),
    ...(changes.issueDate !== undefined && { TxnDate: changes.issueDate }),
    ...(changes.dueDate !== undefined && { DueDate: changes.dueDate }),
    ...(changes.memo !== undefined && { CustomerMemo: { value: changes.memo ?? '' } }),
    ...(changes.lines !== undefined && {
      Line: changes.lines.map((l) => salesLine(l, toSide)),
      ...(current.TxnTaxDetail?.TxnTaxCodeRef && {
        TxnTaxDetail: { TxnTaxCodeRef: current.TxnTaxDetail.TxnTaxCodeRef },
      }),
    }),
  }),
}
