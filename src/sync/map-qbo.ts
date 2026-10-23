// Maps QBO entities to and from the neutral form.
import { decimal, toMoney } from '../money.js'
import type {
  QboAccount,
  QboCustomer,
  QboInvoice,
  QboItem,
  QboPayment,
  QboRef,
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

type InvoiceHeader = Pick<
  QboInvoice,
  'DocNumber' | 'CustomerRef' | 'TxnDate' | 'DueDate' | 'CustomerMemo'
>

export type QboInvoiceWrite = InvoiceHeader & { Line: QboSalesLine[] }

export type QboInvoicePatch = Partial<InvoiceHeader> & {
  Line?: QboSalesLine[]
  TxnTaxDetail?: { TxnTaxCodeRef: QboRef }
}

const DELETED_SUFFIX = ' (deleted)'

// QBO marks a void with a note, not a flag
const hasVoidNote = (note: string | undefined): boolean => (note ?? '').startsWith('Voided')

// a void zeroes the payment and drops its lines; QBO keeps the record
export const isVoidedPayment = (p: QboPayment): boolean =>
  p.TotalAmt === 0 && p.Line.length === 0 && hasVoidNote(p.PrivateNote)

// deactivating a customer, account or item renames it
function originalName(name: string, active: boolean): string {
  if (!active && name.endsWith(DELETED_SUFFIX)) {
    return name.slice(0, -DELETED_SUFFIX.length)
  }
  return name
}

const isSalesLine = (l: QboInvoice['Line'][number]): l is QboSalesLine =>
  l.DetailType === 'SalesItemLineDetail'

// why the invoice has no neutral form, or null when it has one
export function unsupportedInvoice(i: QboInvoice): string | null {
  if (i.CurrencyRef.value !== 'USD') {
    return `currency ${i.CurrencyRef.value} is not supported`
  }
  if (!i.DocNumber) {
    return 'invoice has no number'
  }
  const line = i.Line.find(
    (l) => l.DetailType === 'DescriptionOnly' || l.DetailType === 'DiscountLineDetail'
  )
  return line ? `${line.DetailType} lines are not supported` : null
}

const ref = (value: string) => ({ value })

function salesLine(l: NeutralLine, toSide: ToSide): QboSalesLine {
  const line: QboSalesLine = {
    Amount: Number(l.amount),
    DetailType: 'SalesItemLineDetail',
    SalesItemLineDetail: {
      ItemRef: ref(toSide(l.item)),
      Qty: Number(l.quantity),
      UnitPrice: Number(l.unitPrice),
    },
  }
  if (l.description !== null) {
    line.Description = l.description
  }
  return line
}

// a line linked to several invoices applies nothing
function paymentAllocations(p: QboPayment, toLink: ToLink): NeutralPayment['allocations'] {
  const allocations: NeutralPayment['allocations'] = []
  for (const line of p.Line) {
    const invoices = line.LinkedTxn.filter((t) => t.TxnType === 'Invoice')
    if (invoices.length === 1) {
      allocations.push({
        invoice: toLink('invoice', invoices[0]!.TxnId),
        amount: toMoney(line.Amount),
      })
    }
  }
  return sortAllocations(allocations)
}

export function fromQboAccount(a: QboAccount): NeutralAccount {
  return { name: originalName(a.Name, a.Active), active: a.Active }
}

export function fromQboItem(i: QboItem, toLink: ToLink): NeutralItem | Unsupported {
  if (i.Type === 'Inventory') {
    return { unsupported: 'inventory items are not supported' }
  }
  if (!i.IncomeAccountRef) {
    return { unsupported: 'item has no income account' }
  }
  return {
    name: originalName(i.Name, i.Active),
    incomeAccount: toLink('account', i.IncomeAccountRef.value),
    active: i.Active,
  }
}

export function fromQboCustomer(c: QboCustomer): NeutralCustomer {
  return { name: originalName(c.DisplayName, c.Active), active: c.Active }
}

export function fromQboInvoice(i: QboInvoice, toLink: ToLink): NeutralInvoice | Unsupported {
  const reason = unsupportedInvoice(i)
  if (reason !== null) {
    return { unsupported: reason }
  }
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
}

export function fromQboPayment(p: QboPayment, toLink: ToLink): NeutralPayment {
  return {
    customer: toLink('customer', p.CustomerRef.value),
    date: p.TxnDate,
    amount: toMoney(p.TotalAmt),
    allocations: paymentAllocations(p, toLink),
  }
}

export function toQboCustomer(n: NeutralCustomer): Pick<QboCustomer, 'DisplayName'> {
  return { DisplayName: n.name }
}

export function toQboAccount(n: NeutralAccount): Pick<QboAccount, 'Name' | 'AccountType'> {
  return { Name: n.name, AccountType: 'Income' }
}

export function toQboItem(
  n: NeutralItem,
  toSide: ToSide
): Pick<QboItem, 'Name' | 'Type' | 'IncomeAccountRef'> {
  return { Name: n.name, Type: 'Service', IncomeAccountRef: ref(toSide(n.incomeAccount)) }
}

export function toQboInvoice(n: NeutralInvoice, toSide: ToSide): QboInvoiceWrite {
  const body: QboInvoiceWrite = {
    DocNumber: n.number,
    CustomerRef: ref(toSide(n.customer)),
    TxnDate: n.issueDate,
    DueDate: n.dueDate,
    Line: n.lines.map((l) => salesLine(l, toSide)),
  }
  if (n.memo !== null) {
    body.CustomerMemo = { value: n.memo }
  }
  return body
}

export function toQboPayment(
  n: NeutralPayment,
  toSide: ToSide
): Pick<QboPayment, 'CustomerRef' | 'TotalAmt' | 'TxnDate' | 'Line'> {
  return {
    CustomerRef: ref(toSide(n.customer)),
    TotalAmt: Number(n.amount),
    TxnDate: n.date,
    Line: n.allocations.map((a) => ({
      Amount: Number(a.amount),
      LinkedTxn: [{ TxnId: toSide(a.invoice), TxnType: 'Invoice' }],
    })),
  }
}

export function toQboCustomerPatch(
  changes: Partial<NeutralCustomer>
): Partial<Pick<QboCustomer, 'DisplayName' | 'Active'>> {
  const patch: Partial<Pick<QboCustomer, 'DisplayName' | 'Active'>> = {}
  if (changes.name !== undefined) {
    patch.DisplayName = changes.name
  }
  if (changes.active !== undefined) {
    patch.Active = changes.active
  }
  return patch
}

export function toQboAccountPatch(
  changes: Partial<NeutralAccount>
): Partial<Pick<QboAccount, 'Name' | 'Active'>> {
  const patch: Partial<Pick<QboAccount, 'Name' | 'Active'>> = {}
  if (changes.name !== undefined) {
    patch.Name = changes.name
  }
  if (changes.active !== undefined) {
    patch.Active = changes.active
  }
  return patch
}

export function toQboItemPatch(
  changes: Partial<NeutralItem>,
  toSide: ToSide
): Partial<Pick<QboItem, 'Name' | 'IncomeAccountRef' | 'Active'>> {
  const patch: Partial<Pick<QboItem, 'Name' | 'IncomeAccountRef' | 'Active'>> = {}
  if (changes.name !== undefined) {
    patch.Name = changes.name
  }
  if (changes.incomeAccount !== undefined) {
    patch.IncomeAccountRef = ref(toSide(changes.incomeAccount))
  }
  if (changes.active !== undefined) {
    patch.Active = changes.active
  }
  return patch
}

// void is an operation, not a field, so `voided` is never patched
export function toQboInvoicePatch(
  changes: Partial<NeutralInvoice>,
  current: QboInvoice,
  toSide: ToSide
): QboInvoicePatch {
  const patch: QboInvoicePatch = {}
  if (changes.number !== undefined) {
    patch.DocNumber = changes.number
  }
  if (changes.customer !== undefined) {
    patch.CustomerRef = ref(toSide(changes.customer))
  }
  if (changes.issueDate !== undefined) {
    patch.TxnDate = changes.issueDate
  }
  if (changes.dueDate !== undefined) {
    patch.DueDate = changes.dueDate
  }
  if (changes.memo !== undefined) {
    patch.CustomerMemo = { value: changes.memo ?? '' }
  }
  if (changes.lines !== undefined) {
    patch.Line = changes.lines.map((l) => salesLine(l, toSide))
    const taxCode = current.TxnTaxDetail?.TxnTaxCodeRef
    if (taxCode) {
      patch.TxnTaxDetail = { TxnTaxCodeRef: taxCode }
    }
  }
  return patch
}
