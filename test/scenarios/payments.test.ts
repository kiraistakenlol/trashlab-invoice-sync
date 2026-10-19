// Payments synced both ways (SCENARIOS.md P1-P10) and lost payment creates (R1, R2).
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

describe('P1, P2 the invoice balance a payment moved', () => {
  it.each(['invoicing', 'qbo'] as const)('is not synced for a payment from %s', async (side) => {
    // Given
    const given = await invoiceOf100()
    // When
    if (side === 'invoicing') await linkedPayment(w, given.invoice, '100.00')
    else {
      await w.qboActor.createPayment(given.customer.qboId, '40.00', [
        { invoiceId: given.qboId, amount: '40.00' },
      ])
      await w.sync()
    }
    // Then
    await balanceMoved(given.qboId)
    expect(await updates('invoicing', given.invoice.id)).toEqual([])
    expect(await updates('qbo', given.qboId)).toEqual([])
  })
})

describe('P3 partial payments add up', () => {
  it('shows balances 70, 20 and 0 on both sides', async () => {
    // Given
    const given = await invoiceOf100()
    const balances = async () => ({
      invoicing: (await w.invoicing.getInvoice(given.invoice.id))!.balance,
      qbo: (await w.qboActor.get('Invoice', given.qboId))!.Balance,
    })
    // When, Then
    await linkedPayment(w, given.invoice, '30.00')
    expect(await balances()).toEqual({ invoicing: '70.00', qbo: 70 })
    await w.qboActor.createPayment(given.customer.qboId, '50.00', [
      { invoiceId: given.qboId, amount: '50.00' },
    ])
    await w.sync()
    expect(await balances()).toEqual({ invoicing: '20.00', qbo: 20 })
    await linkedPayment(w, given.invoice, '20.00')
    expect(await balances()).toEqual({ invoicing: '0.00', qbo: 0 })
    expect(await w.invoicing.getInvoice(given.invoice.id)).toMatchObject({ status: 'paid' })
    expect(await w.issues()).toEqual([])
  })
})

describe('P4 one payment over two invoices', () => {
  it('copies both allocations to one invoicing payment', async () => {
    // Given
    const first = await invoiceOf100()
    const { invoice, qboId } = await linkedInvoice(w, {
      customer: first.customer.customer,
      lines: [{ itemId: first.item.item.id, quantity: '1', unitPrice: '100.00', amount: '100.00' }],
    })
    // When
    await w.qboActor.createPayment(first.customer.qboId, '100.00', [
      { invoiceId: first.qboId, amount: '60.00' },
      { invoiceId: qboId, amount: '40.00' },
    ])
    await w.sync()
    // Then
    const payments = await w.invoicing.listPayments()
    expect(payments).toHaveLength(1)
    // allocations are ordered by the invoices' link ids
    const linkId = async (id: string) => (await w.linkOf('invoice', 'invoicing', id))!.id
    const ordered = [
      { invoiceId: first.invoice.id, amount: '60.00', link: await linkId(first.invoice.id) },
      { invoiceId: invoice.id, amount: '40.00', link: await linkId(invoice.id) },
    ]
      .sort((a, b) => (a.link < b.link ? -1 : 1))
      .map(({ invoiceId, amount }) => ({ invoiceId, amount }))
    expect(payments[0]).toMatchObject({ amount: '100.00', unapplied: '0.00', allocations: ordered })
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
    const { qboId: paymentQboId } = await linkedPayment(w, given.invoice, '60.00')
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
    if (system === 'invoicing') {
      const invoiceLink = (await w.linkOf('invoice', 'qbo', given.qboId))!
      expect(
        (await w.history('qbo', 'payment', paymentQboId)).map((e) => [e.action, e.details])
      ).toContainEqual([
        'notification_received',
        { source: 'invoice', invoiceLinkId: invoiceLink.id },
      ])
    }
  })
})

describe('P9 total reduced below the paid amount in QBO', () => {
  it('lowers the allocation to 70 first, then the invoice total', async () => {
    // Given
    const given = await invoiceOf100()
    const { payment } = await linkedPayment(w, given.invoice, '100.00')
    // When
    await w.qboActor.updateInvoice(given.qboId, { Line: [qboLine(given.item.qboId, 1, 70, 70)] })
    await w.sync()
    // Then
    expect(await w.invoicing.getPayment(payment.id)).toMatchObject({
      amount: '100.00',
      allocations: [{ invoiceId: given.invoice.id, amount: '70.00' }],
      unapplied: '30.00',
    })
    expect(await w.invoicing.getInvoice(given.invoice.id)).toMatchObject({
      total: '70.00',
      balance: '0.00',
    })
    const [allocated] = await w
      .history('invoicing', 'payment', payment.id)
      .then((h) => h.filter((e) => e.action === 'updated'))
    const [reduced] = await updates('invoicing', given.invoice.id)
    expect(allocated!.error).toBeNull()
    expect(reduced!.error).toBeNull()
    expect(BigInt(allocated!.id)).toBeLessThan(BigInt(reduced!.id))
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
    await w.clock.advance(PAST_BACKOFF_MS)
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
    await w.clock.advance(PAST_BACKOFF_MS)
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
    await w.clock.advance(PAST_BACKOFF_MS)
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

describe('P10 payment allocated to an invoice voided or deleted on the other side', () => {
  const failedJobs = () =>
    w.db.selectFrom('sync_jobs').select('id').where('status', '=', 'failed').execute()

  const paymentIssues = async () => (await w.issues()).filter((i) => i.ref.entityType === 'payment')

  // a payment of 40.00 recorded in invoicing, not synced yet
  async function invoicingPayment(invoiceId: string, customerId: string) {
    const payment = await w.invoicing.createPayment(
      {
        customerId,
        amount: '40.00',
        date: ISSUE_DATE,
        allocations: [{ invoiceId, amount: '40.00' }],
      },
      randomUUID()
    )
    return payment
  }

  it.each(['voided', 'deleted'] as const)(
    'a payment from invoicing for an invoice %s in QBO is flagged, nothing written',
    async (change) => {
      // Given
      const given = await invoiceOf100()
      await invoicingPayment(given.invoice.id, given.invoice.customerId)
      // When the invoice changes in QBO before the payment is synced
      if (change === 'voided') await w.qboActor.voidInvoice(given.qboId)
      else await w.qboActor.deleteInvoice(given.qboId)
      await w.sync()
      // Then
      expect(await qboPayments()).toEqual([])
      expect(await paymentIssues()).toEqual([
        expect.objectContaining({
          kind: 'conflict',
          resolvedAt: null,
          details: expect.objectContaining({ reason: `allocated invoice ${change} in qbo` }),
        }),
      ])
      expect(await failedJobs()).toEqual([])
    }
  )

  it('syncs the payment and closes the issue once the allocation is removed', async () => {
    // Given
    const given = await invoiceOf100()
    const payment = await invoicingPayment(given.invoice.id, given.invoice.customerId)
    await w.qboActor.voidInvoice(given.qboId)
    await w.sync()
    // When a person removes the allocation in invoicing
    await w.invoicing.replacePayment(
      payment.id,
      { customerId: payment.customerId, amount: '40.00', date: ISSUE_DATE, allocations: [] },
      payment.version
    )
    await w.sync()
    // Then
    const [qboPayment, ...more] = (await qboPayments()) as { TotalAmt: number; Line: unknown[] }[]
    expect(more).toEqual([])
    expect(qboPayment).toMatchObject({ TotalAmt: 40, Line: [] })
    expect(await paymentIssues()).toEqual([expect.objectContaining({ resolution: 'converged' })])
  })

  it('nothing is sent, so an armed timeout after the QBO payment create never fires', async () => {
    // Given
    const given = await invoiceOf100()
    await invoicingPayment(given.invoice.id, given.invoice.customerId)
    w.invoicing.takeWebhooks()
    await w.qboActor.voidInvoice(given.qboId)
    w.qbo.failNext({ method: 'POST', path: '/payment' }, 'timeout_after_write')
    // When
    await w.sync()
    await w.clock.advance(PAST_BACKOFF_MS)
    await w.poll()
    await w.sync()
    // Then
    expect(await qboPayments()).toEqual([])
    expect(await w.invoicing.listPayments()).toHaveLength(1)
    expect(await paymentIssues()).toHaveLength(1)
  })

  it('a payment from QBO for an invoice voided in invoicing lands unapplied, no failed job', async () => {
    // Given
    const given = await invoiceOf100()
    await w.invoicing.voidInvoice(given.invoice.id, given.invoice.version)
    // When a payment is applied in QBO before the void is synced
    await w.qboActor.createPayment(given.customer.qboId, '40.00', [
      { invoiceId: given.qboId, amount: '40.00' },
    ])
    await w.sync()
    // the void reached QBO, which freed the payment; CDC reports the payment changed
    await w.poll()
    await w.sync()
    // Then
    const [payment, ...more] = await w.invoicing.listPayments()
    expect(more).toEqual([])
    expect(payment).toMatchObject({ amount: '40.00', allocations: [], unapplied: '40.00' })
    expect(await w.qboActor.get('Invoice', given.qboId)).toMatchObject({ TotalAmt: 0 })
    expect(await failedJobs()).toEqual([])
    expect(await paymentIssues()).toEqual([
      expect.objectContaining({
        resolution: 'converged',
        details: expect.objectContaining({ reason: 'allocated invoice voided in invoicing' }),
      }),
    ])
  })
})
