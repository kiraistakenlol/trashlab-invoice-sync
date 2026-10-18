// Steps shared by the scenarios: records made in invoicing and synced, notification filters.
import { randomUUID } from 'node:crypto'
import type { EntityType } from '../../src/db/database.js'
import type {
  Customer,
  Invoice,
  InvoiceLineInput,
  InvoiceReplace,
  InvoicingEvent,
  Item,
  Payment,
} from '../../src/invoicing/types.js'
import type { Money } from '../../src/money.js'
import type { QboWebhookEntity } from '../../src/qbo/webhooks.js'
import type { ScenarioWorld } from '../harness/world.js'

export const ISSUE_DATE = '2026-01-05'
export const DUE_DATE = '2026-02-04'

type Notification = QboWebhookEntity | InvoicingEvent

// filters for `deliver({ drop })`
export const invoicingEvents =
  (...types: EntityType[]) =>
  (e: Notification): boolean =>
    'entityType' in e && types.includes(e.entityType)

export const qboEvents = (e: Notification): boolean => !('entityType' in e)

const qboIdOf = async (w: ScenarioWorld, entityType: EntityType, id: string) => {
  const qboId = (await w.linkOf(entityType, 'invoicing', id))?.qboId
  if (!qboId) throw new Error(`invoicing ${entityType} ${id} is not linked`)
  return qboId
}

export async function linkedCustomer(
  w: ScenarioWorld,
  name: string
): Promise<{ customer: Customer; qboId: string }> {
  const customer = await w.invoicing.createCustomer({ name: w.named(name) }, randomUUID())
  await w.sync()
  return { customer, qboId: await qboIdOf(w, 'customer', customer.id) }
}

export async function linkedItem(
  w: ScenarioWorld,
  name: string,
  accountName: string
): Promise<{ item: Item; qboId: string }> {
  const account = await w.invoicing.createAccount({ name: w.named(accountName) }, randomUUID())
  const item = await w.invoicing.createItem(
    { name: w.named(name), incomeAccountId: account.id },
    randomUUID()
  )
  await w.sync()
  return { item, qboId: await qboIdOf(w, 'item', item.id) }
}

export async function linkedInvoice(
  w: ScenarioWorld,
  opts: { customer?: Customer; lines: InvoiceLineInput[]; memo?: string }
): Promise<{ invoice: Invoice; qboId: string }> {
  const customer = opts.customer ?? (await linkedCustomer(w, 'Acme')).customer
  const invoice = await w.invoicing.createInvoice(
    {
      customerId: customer.id,
      issueDate: ISSUE_DATE,
      dueDate: DUE_DATE,
      memo: opts.memo ?? null,
      lines: opts.lines,
    },
    randomUUID()
  )
  await w.sync()
  return { invoice, qboId: await qboIdOf(w, 'invoice', invoice.id) }
}

// a payment recorded in invoicing, allocated in full to one invoice, and synced
export async function linkedPayment(
  w: ScenarioWorld,
  invoice: Invoice,
  amount: Money
): Promise<{ payment: Payment; qboId: string }> {
  const payment = await w.invoicing.createPayment(
    {
      customerId: invoice.customerId,
      amount,
      date: ISSUE_DATE,
      allocations: [{ invoiceId: invoice.id, amount }],
    },
    randomUUID()
  )
  await w.sync()
  return { payment, qboId: await qboIdOf(w, 'payment', payment.id) }
}

// a person editing the invoice in invoicing: the current invoice with `changes` replaced
export async function editInvoice(
  w: ScenarioWorld,
  id: string,
  changes: Partial<InvoiceReplace>
): Promise<Invoice> {
  const current = (await w.invoicing.getInvoice(id))!
  return w.invoicing.replaceInvoice(
    id,
    {
      customerId: current.customerId,
      issueDate: current.issueDate,
      dueDate: current.dueDate,
      memo: current.memo,
      tax: current.tax,
      lines: current.lines,
      ...changes,
    },
    current.version
  )
}

// a QBO sales line as sent in an update
export const qboLine = (itemId: string, qty: number, unitPrice: number, amount: number) => ({
  Amount: amount,
  DetailType: 'SalesItemLineDetail',
  SalesItemLineDetail: { ItemRef: { value: itemId }, Qty: qty, UnitPrice: unitPrice },
})

export interface TwoLineInvoice {
  invoice: Invoice
  qboId: string
  pickup: { item: Item; qboId: string }
  disposal: { item: Item; qboId: string }
}

// a linked invoice: 2 x 50.00 pickup and 1 x 30.00 disposal
export async function twoLineInvoice(w: ScenarioWorld): Promise<TwoLineInvoice> {
  const pickup = await linkedItem(w, 'Pickup', 'Hauling')
  const disposal = await linkedItem(w, 'Disposal', 'Landfill')
  const { invoice, qboId } = await linkedInvoice(w, {
    lines: [
      { itemId: pickup.item.id, quantity: '2', unitPrice: '50.00', amount: '100.00' },
      { itemId: disposal.item.id, quantity: '1', unitPrice: '30.00', amount: '30.00' },
    ],
  })
  return { invoice, qboId, pickup, disposal }
}
