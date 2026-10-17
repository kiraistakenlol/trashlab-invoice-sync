// Payments synced both ways (SCENARIOS.md P1, P2, P5, P6, P7, P8) and lost payment creates (R1, R2).
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { System } from '../../src/db/database.js'
import { createWorld, type World } from '../harness/world.js'
import {
  editInvoice,
  invoicingEvents,
  ISSUE_DATE,
  linkedCustomer,
  linkedInvoice,
  linkedItem,
  linkedPayment,
  qboEvents,
  qboLine,
} from './given.js'

const PAST_BACKOFF_MS = 1_000

let w: World
beforeEach(async () => {
  w = await createWorld()
})
afterEach(() => w.close())

// a linked invoice of 1 x 100.00 for a linked customer
async function invoiceOf100() {
  const customer = await linkedCustomer(w, 'Acme')
  const item = await linkedItem(w, 'Pickup', 'Hauling')
  const { invoice, qboId } = await linkedInvoice(w, {
    customer: customer.customer,
    lines: [{ itemId: item.item.id, quantity: '1', unitPrice: '100.00', amount: '100.00' }],
  })
  return { customer, item, invoice, qboId }
}

const updates = async (system: System, id: string) =>
  (await w.history(system, 'invoice', id)).filter((e) => e.action === 'updated')

// QBO notifies about an invoice whose balance a payment moved; balances aren't synced
async function balanceMoved(qboId: string): Promise<void> {
  const invoice = (await w.qboActor.get('Invoice', qboId))!
  const lastUpdated = invoice.MetaData.LastUpdatedTime
  await w.webhook('qbo', [{ name: 'Invoice', id: qboId, operation: 'Update', lastUpdated }])
  await w.sync()
  expect((await w.history('qbo', 'invoice', qboId)).at(-1)).toMatchObject({
    action: 'no_change',
  })
}

describe('P1 payment recorded in invoicing appears in QBO', () => {
  it('creates and links a QBO payment applied to the invoice', async () => {
    // Given
    const given = await invoiceOf100()
    // When
    const { payment, qboId } = await linkedPayment(w, given.invoice, '100.00')
    // Then
    expect(await w.qboActor.get('Payment', qboId)).toMatchObject({
      CustomerRef: { value: given.customer.qboId },
      TotalAmt: 100,
      Line: [{ Amount: 100, LinkedTxn: [{ TxnId: given.qboId, TxnType: 'Invoice' }] }],
    })
    expect(await w.qboActor.get('Invoice', given.qboId)).toMatchObject({ Balance: 0 })
    expect(await w.linkOf('payment', 'qbo', qboId)).toMatchObject({ invoicingId: payment.id })
    expect(await w.invoicing.getInvoice(given.invoice.id)).toMatchObject({ status: 'paid' })
    await balanceMoved(given.qboId)
    expect(await updates('invoicing', given.invoice.id)).toEqual([])
    expect(await updates('qbo', given.qboId)).toEqual([])
    expect(await w.issues()).toEqual([])
  })
})

describe('P2 payment recorded in QBO appears in invoicing', () => {
  it('creates an invoicing payment allocated to the invoice', async () => {
    // Given
    const given = await invoiceOf100()
    // When
    const qboPayment = await w.qboActor.createPayment(given.customer.qboId, '40.00', [
      { invoiceId: given.qboId, amount: '40.00' },
    ])
    await w.sync()
    // Then
    const link = (await w.linkOf('payment', 'qbo', qboPayment.Id))!
    expect(await w.invoicing.getPayment(link.invoicingId!)).toMatchObject({
      customerId: given.customer.customer.id,
      amount: '40.00',
      allocations: [{ invoiceId: given.invoice.id, amount: '40.00' }],
    })
    expect(await w.invoicing.getInvoice(given.invoice.id)).toMatchObject({
      status: 'partly_paid',
      paid: '40.00',
      balance: '60.00',
    })
    await balanceMoved(given.qboId)
    expect(await updates('invoicing', given.invoice.id)).toEqual([])
    expect(await updates('qbo', given.qboId)).toEqual([])
    expect(await w.issues()).toEqual([])
  })
})

describe('P6 payment deleted or voided in QBO', () => {
  it.each(['delete', 'void'] as const)('deletes the invoicing payment on %s', async (how) => {
    // Given
    const given = await invoiceOf100()
    const { payment, qboId } = await linkedPayment(w, given.invoice, '40.00')
    // When
    if (how === 'delete') await w.qboActor.deletePayment(qboId)
    else await w.qboActor.voidPayment(qboId)
    await w.sync()
    // Then
    expect((await w.invoicing.getPayment(payment.id))!.deletedAt).not.toBeNull()
    expect(await w.invoicing.getInvoice(given.invoice.id)).toMatchObject({
      status: 'open',
      balance: '100.00',
    })
    expect((await w.linkOf('payment', 'qbo', qboId))!.deletedAt).not.toBeNull()
    expect(await w.history('invoicing', 'payment', payment.id)).toContainEqual(
      expect.objectContaining({ action: 'deleted', error: null })
    )
    expect(await w.issues()).toEqual([])
  })
})

describe("P7 payment for an invoice that isn't synced yet", () => {
  it('links the invoice first, then syncs the payment', async () => {
    // Given
    const customer = await linkedCustomer(w, 'Acme')
    const item = await linkedItem(w, 'Pickup', 'Hauling')
    const qboInvoice = await w.qboActor.createInvoice(customer.qboId, [
      { amount: '100.00', itemId: item.qboId },
    ])
    const qboPayment = await w.qboActor.createPayment(customer.qboId, '40.00', [
      { invoiceId: qboInvoice.Id, amount: '40.00' },
    ])
    // When only the payment's notification is processed
    await w.deliver({ drop: (e) => !('name' in e && e.name === 'Payment') })
    await w.drain()
    // Then
    const invoiceLink = (await w.linkOf('invoice', 'qbo', qboInvoice.Id))!
    const paymentLink = (await w.linkOf('payment', 'qbo', qboPayment.Id))!
    expect(await w.invoicing.getPayment(paymentLink.invoicingId!)).toMatchObject({
      amount: '40.00',
      allocations: [{ invoiceId: invoiceLink.invoicingId, amount: '40.00' }],
    })
    expect(await w.invoicing.getInvoice(invoiceLink.invoicingId!)).toMatchObject({
      total: '100.00',
      status: 'partly_paid',
    })
    expect(await w.issues()).toEqual([])
  })
})

describe('P8 editing a partially paid invoice', () => {
  it.each(['invoicing', 'qbo'] as const)('total changed to 80 in %s', async (system) => {
    // Given
    const given = await invoiceOf100()
    await linkedPayment(w, given.invoice, '60.00')
    // When
    if (system === 'invoicing') {
      const [line] = (await w.invoicing.getInvoice(given.invoice.id))!.lines
      await editInvoice(w, given.invoice.id, {
        lines: [{ ...line!, unitPrice: '80.00', amount: '80.00' }],
      })
    } else {
      await w.qboActor.updateInvoice(given.qboId, { Line: [qboLine(given.item.qboId, 1, 80, 80)] })
    }
    await w.sync()
    // Then
    expect(await w.invoicing.getInvoice(given.invoice.id)).toMatchObject({
      total: '80.00',
      paid: '60.00',
      balance: '20.00',
      status: 'partly_paid',
    })
    expect(await w.qboActor.get('Invoice', given.qboId)).toMatchObject({
      TotalAmt: 80,
      Balance: 20,
    })
    expect(await w.issues()).toEqual([])
  })
})

describe('P5 payment edited', () => {
  it('copies a new amount and allocation from invoicing to QBO', async () => {
    // Given
    const given = await invoiceOf100()
    const { payment, qboId } = await linkedPayment(w, given.invoice, '40.00')
    // When
    await w.invoicing.replacePayment(
      payment.id,
      {
        customerId: payment.customerId,
        amount: '70.00',
        date: payment.date,
        allocations: [{ invoiceId: given.invoice.id, amount: '60.00' }],
      },
      payment.version
    )
    await w.sync()
    // Then
    expect(await w.qboActor.get('Payment', qboId)).toMatchObject({
      TotalAmt: 70,
      UnappliedAmt: 10,
      Line: [{ Amount: 60, LinkedTxn: [{ TxnId: given.qboId }] }],
    })
    expect(await w.qboActor.get('Invoice', given.qboId)).toMatchObject({ Balance: 40 })
    expect(await w.history('qbo', 'payment', qboId)).toContainEqual(
      expect.objectContaining({ action: 'updated', error: null })
    )
    expect(await w.issues()).toEqual([])
  })

  it('copies a new amount and allocation from QBO to invoicing', async () => {
    // Given
    const given = await invoiceOf100()
    const { payment, qboId } = await linkedPayment(w, given.invoice, '40.00')
    // When
    await w.qboActor.updatePayment(qboId, {
      CustomerRef: { value: given.customer.qboId },
      TotalAmt: 70,
      Line: [{ Amount: 60, LinkedTxn: [{ TxnId: given.qboId, TxnType: 'Invoice' }] }],
    })
    await w.sync()
    // Then
    expect(await w.invoicing.getPayment(payment.id)).toMatchObject({
      amount: '70.00',
      unapplied: '10.00',
      allocations: [{ invoiceId: given.invoice.id, amount: '60.00' }],
    })
    expect(await w.invoicing.getInvoice(given.invoice.id)).toMatchObject({ balance: '40.00' })
    expect(await w.history('invoicing', 'payment', payment.id)).toContainEqual(
      expect.objectContaining({ action: 'updated', error: null })
    )
    expect(await w.issues()).toEqual([])
  })
})

const qboPayments = async () =>
  ((await w.qbo.query('select * from Payment')).body as { QueryResponse: { Payment?: unknown[] } })
    .QueryResponse.Payment ?? []

describe('R1 timeout after a payment write to QBO', () => {
  const lostCreate = async () => {
    const given = await invoiceOf100()
    w.qbo.failNext({ method: 'POST', path: '/payment' }, 'timeout_after_write')
    const payment = await w.invoicing.createPayment(
      {
        customerId: given.invoice.customerId,
        amount: '40.00',
        date: ISSUE_DATE,
        allocations: [{ invoiceId: given.invoice.id, amount: '40.00' }],
      },
      randomUUID()
    )
    await w.deliver()
    await w.drain()
    return payment
  }

  it('adopts the QBO payment when its notification arrives before the retry', async () => {
    // Given the response is lost
    const payment = await lostCreate()
    // When QBO's notification of the new payment is processed, then the retry runs
    await w.deliver({ drop: invoicingEvents('payment') })
    await w.drain()
    w.clock.advance(PAST_BACKOFF_MS)
    await w.sync()
    // Then
    const [qboPayment, ...more] = (await qboPayments()) as { Id: string }[]
    expect(more).toEqual([])
    expect(await w.linkOf('payment', 'invoicing', payment.id)).toMatchObject({
      qboId: qboPayment!.Id,
    })
    expect(await w.history('qbo', 'payment', qboPayment!.Id)).toContainEqual(
      expect.objectContaining({
        action: 'linked',
        details: expect.objectContaining({ adopted: true }),
      })
    )
    expect(await w.invoicing.listPayments()).toHaveLength(1)
    expect(await w.issues()).toEqual([])
  })

  it('replays the key when the notification is lost too', async () => {
    // Given the response is lost, and QBO's notification of the new payment with it
    const payment = await lostCreate()
    await w.deliver({ drop: qboEvents })
    // When
    w.clock.advance(PAST_BACKOFF_MS)
    await w.sync()
    // Then
    const [qboPayment, ...more] = (await qboPayments()) as { Id: string }[]
    expect(more).toEqual([])
    expect(await w.linkOf('payment', 'invoicing', payment.id)).toMatchObject({
      qboId: qboPayment!.Id,
    })
    expect(await w.invoicing.listPayments()).toHaveLength(1)
    expect(await w.issues()).toEqual([])
  })
})

describe('R2 timeout after a payment write to invoicing', () => {
  it('retries under the same key and gets the same payment back', async () => {
    // Given
    const given = await invoiceOf100()
    w.invoicing.failNext('createPayment', 'timeout_after_write')
    const qboPayment = await w.qboActor.createPayment(given.customer.qboId, '40.00', [
      { invoiceId: given.qboId, amount: '40.00' },
    ])
    // When the response is lost, and invoicing's notification of the new payment with it
    await w.deliver()
    await w.drain()
    await w.deliver({ drop: invoicingEvents('payment') })
    w.clock.advance(PAST_BACKOFF_MS)
    await w.sync()
    // Then
    const [payment, ...more] = await w.invoicing.listPayments()
    expect(more).toEqual([])
    expect(await w.linkOf('payment', 'qbo', qboPayment.Id)).toMatchObject({
      invoicingId: payment!.id,
    })
    expect(await qboPayments()).toHaveLength(1)
    expect(await w.issues()).toEqual([])
  })
})
