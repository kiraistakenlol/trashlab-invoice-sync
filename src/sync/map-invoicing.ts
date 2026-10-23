// Maps invoicing system records to and from the neutral form.
import { decimal } from '../money.js'
import type {
  Account,
  AccountInput,
  CatalogueUpdate,
  Customer,
  CustomerInput,
  Invoice,
  InvoiceLineInput,
  InvoiceReplace,
  Item,
  ItemInput,
  Payment,
  PaymentInput,
} from '../invoicing/types.js'
import { sortAllocations } from './neutral.js'
import type {
  NeutralAccount,
  NeutralCustomer,
  NeutralInvoice,
  NeutralItem,
  NeutralPayment,
  ToLink,
  ToSide,
} from './neutral.js'

export function fromInvoicingAccount(a: Account): NeutralAccount {
  return { name: a.name, active: a.deactivatedAt === null }
}

export function fromInvoicingItem(i: Item, toLink: ToLink): NeutralItem {
  return {
    name: i.name,
    incomeAccount: toLink('account', i.incomeAccountId),
    active: i.deactivatedAt === null,
  }
}

export function fromInvoicingCustomer(c: Customer): NeutralCustomer {
  return { name: c.name, active: c.deactivatedAt === null }
}

export function fromInvoicingInvoice(i: Invoice, toLink: ToLink): NeutralInvoice {
  return {
    number: i.number,
    customer: toLink('customer', i.customerId),
    issueDate: i.issueDate,
    dueDate: i.dueDate,
    memo: i.memo || null,
    lines: i.lines.map((l) => ({
      item: toLink('item', l.itemId),
      description: l.description,
      quantity: decimal(l.quantity),
      unitPrice: l.unitPrice,
      amount: l.amount,
    })),
    tax: i.tax,
    voided: i.status === 'void',
  }
}

export function fromInvoicingPayment(p: Payment, toLink: ToLink): NeutralPayment {
  return {
    customer: toLink('customer', p.customerId),
    date: p.date,
    amount: p.amount,
    allocations: sortAllocations(
      p.allocations.map((a) => ({ invoice: toLink('invoice', a.invoiceId), amount: a.amount }))
    ),
  }
}

export function toInvoicingAccount(n: NeutralAccount): AccountInput {
  return { name: n.name }
}

export function toInvoicingItem(n: NeutralItem, toSide: ToSide): ItemInput {
  return { name: n.name, incomeAccountId: toSide(n.incomeAccount) }
}

export function toInvoicingCustomer(n: NeutralCustomer): CustomerInput {
  return { name: n.name }
}

export function toInvoicingAccountPatch(
  changes: Partial<NeutralAccount>
): CatalogueUpdate<AccountInput> {
  const patch: CatalogueUpdate<AccountInput> = {}
  if (changes.name !== undefined) {
    patch.name = changes.name
  }
  if (changes.active !== undefined) {
    patch.deactivated = !changes.active
  }
  return patch
}

export function toInvoicingItemPatch(
  changes: Partial<NeutralItem>,
  toSide: ToSide
): CatalogueUpdate<ItemInput> {
  const patch: CatalogueUpdate<ItemInput> = {}
  if (changes.name !== undefined) {
    patch.name = changes.name
  }
  if (changes.incomeAccount !== undefined) {
    patch.incomeAccountId = toSide(changes.incomeAccount)
  }
  if (changes.active !== undefined) {
    patch.deactivated = !changes.active
  }
  return patch
}

export function toInvoicingCustomerPatch(
  changes: Partial<NeutralCustomer>
): CatalogueUpdate<CustomerInput> {
  const patch: CatalogueUpdate<CustomerInput> = {}
  if (changes.name !== undefined) {
    patch.name = changes.name
  }
  if (changes.active !== undefined) {
    patch.deactivated = !changes.active
  }
  return patch
}

// line ids of the current invoice are reused by position
export function toInvoicingInvoice(
  n: NeutralInvoice,
  toSide: ToSide,
  current?: Invoice
): InvoiceReplace & { number: string } {
  const lines = n.lines.map((l, index) => {
    const line: InvoiceLineInput = {
      itemId: toSide(l.item),
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      amount: l.amount,
    }
    const id = current?.lines[index]?.id
    if (id !== undefined) {
      line.id = id
    }
    return line
  })
  return {
    number: n.number,
    customerId: toSide(n.customer),
    issueDate: n.issueDate,
    dueDate: n.dueDate,
    memo: n.memo,
    tax: n.tax,
    lines,
  }
}

export function toInvoicingPayment(n: NeutralPayment, toSide: ToSide): PaymentInput {
  return {
    customerId: toSide(n.customer),
    amount: n.amount,
    date: n.date,
    allocations: n.allocations.map((a) => ({ invoiceId: toSide(a.invoice), amount: a.amount })),
  }
}
