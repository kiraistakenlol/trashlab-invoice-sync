// Maps invoicing system records to and from the neutral form.
import { decimal } from '../money.js'
import type { EntityType } from '../db/database.js'
import type {
  Account,
  AccountInput,
  CatalogueUpdate,
  Customer,
  CustomerInput,
  Invoice,
  InvoiceReplace,
  Item,
  ItemInput,
  Payment,
  PaymentInput,
} from '../invoicing/types.js'
import type {
  NeutralAccount,
  NeutralCustomer,
  NeutralInvoice,
  NeutralItem,
  NeutralPayment,
} from './neutral.js'

export type ToLink = (entityType: EntityType, id: string) => string
export type ToSide = (linkId: string) => string

export const invoicingToNeutral = {
  account: (a: Account): NeutralAccount => ({ name: a.name, active: a.deactivatedAt === null }),

  item: (i: Item, toLink: ToLink): NeutralItem => ({
    name: i.name,
    incomeAccount: toLink('account', i.incomeAccountId),
    active: i.deactivatedAt === null,
  }),

  customer: (c: Customer): NeutralCustomer => ({
    name: c.name,
    active: c.deactivatedAt === null,
  }),

  invoice: (i: Invoice, toLink: ToLink): NeutralInvoice => ({
    number: i.number,
    customer: toLink('customer', i.customerId),
    issueDate: i.issueDate,
    dueDate: i.dueDate,
    memo: i.memo,
    lines: i.lines.map((l) => ({
      item: toLink('item', l.itemId),
      description: l.description,
      quantity: decimal(l.quantity),
      unitPrice: l.unitPrice,
      amount: l.amount,
    })),
    tax: i.tax,
    voided: i.status === 'void',
  }),

  payment: (p: Payment, toLink: ToLink): NeutralPayment => ({
    customer: toLink('customer', p.customerId),
    date: p.date,
    amount: p.amount,
    allocations: p.allocations
      .map((a) => ({ invoice: toLink('invoice', a.invoiceId), amount: a.amount }))
      .sort((a, b) => (a.invoice < b.invoice ? -1 : a.invoice > b.invoice ? 1 : 0)),
  }),
}

export const neutralToInvoicing = {
  account: (n: NeutralAccount): AccountInput => ({ name: n.name }),

  item: (n: NeutralItem, toSide: ToSide): ItemInput => ({
    name: n.name,
    incomeAccountId: toSide(n.incomeAccount),
  }),

  customer: (n: NeutralCustomer): CustomerInput => ({ name: n.name }),

  accountPatch: (changes: Partial<NeutralAccount>): CatalogueUpdate<AccountInput> => ({
    ...(changes.name !== undefined && { name: changes.name }),
    ...(changes.active !== undefined && { deactivated: !changes.active }),
  }),

  itemPatch: (changes: Partial<NeutralItem>, toSide: ToSide): CatalogueUpdate<ItemInput> => ({
    ...(changes.name !== undefined && { name: changes.name }),
    ...(changes.incomeAccount !== undefined && {
      incomeAccountId: toSide(changes.incomeAccount),
    }),
    ...(changes.active !== undefined && { deactivated: !changes.active }),
  }),

  customerPatch: (changes: Partial<NeutralCustomer>): CatalogueUpdate<CustomerInput> => ({
    ...(changes.name !== undefined && { name: changes.name }),
    ...(changes.active !== undefined && { deactivated: !changes.active }),
  }),

  // line ids of the current invoice are reused by position
  invoice: (
    n: NeutralInvoice,
    toSide: ToSide,
    current?: Invoice
  ): InvoiceReplace & { number: string } => ({
    number: n.number,
    customerId: toSide(n.customer),
    issueDate: n.issueDate,
    dueDate: n.dueDate,
    memo: n.memo,
    tax: n.tax,
    lines: n.lines.map((l, index) => {
      const id = current?.lines[index]?.id
      return {
        ...(id !== undefined && { id }),
        itemId: toSide(l.item),
        description: l.description,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        amount: l.amount,
      }
    }),
  }),

  payment: (n: NeutralPayment, toSide: ToSide): PaymentInput => ({
    customerId: toSide(n.customer),
    amount: n.amount,
    date: n.date,
    allocations: n.allocations.map((a) => ({ invoiceId: toSide(a.invoice), amount: a.amount })),
  }),
}
