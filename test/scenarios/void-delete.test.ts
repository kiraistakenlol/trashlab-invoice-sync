// Voids and deletes across systems (SCENARIOS.md V1, V2, V4, V7).
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { System } from '../../src/db/database.js'
import type { InvoicingEventKind } from '../../src/invoicing/types.js'
import type { QboWebhookEntity } from '../../src/qbo/webhooks.js'
import { createWorld, type World } from '../harness/world.js'
import {
  editInvoice,
  invoicingEvents,
  ISSUE_DATE,
  linkedCustomer,
  linkedInvoice,
  linkedItem,
  linkedPayment,
} from './given.js'

const EDITED_MEMO = 'Gate code 1234'

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

const writes = async (system: System, id: string) =>
  (await w.history(system, 'invoice', id)).filter((e) =>
    ['updated', 'voided', 'deleted'].includes(e.action)
  )

interface LastChange {
  invoicing: InvoicingEventKind
  qbo: QboWebhookEntity['operation']
}

const VOIDED_BOTH: LastChange = { invoicing: 'voided', qbo: 'Void' }

// both systems notify about their last change to the invoice again; nothing may be written
async function followUpWritesNothing(
  invoiceId: string,
  qboId: string,
  last: LastChange
): Promise<void> {
  const before = [...(await writes('invoicing', invoiceId)), ...(await writes('qbo', qboId))]
  const qbo = (await w.qboActor.get('Invoice', qboId))!
  const lastUpdated = qbo.MetaData.LastUpdatedTime
  await w.webhook('qbo', [{ name: 'Invoice', id: qboId, operation: last.qbo, lastUpdated }])
  const { version } = (await w.invoicing.getInvoice(invoiceId))!
  await w.webhook('invoicing', [
    { id: randomUUID(), entityType: 'invoice', entityId: invoiceId, kind: last.invoicing, version },
  ])
  await w.sync()
  const after = [...(await writes('invoicing', invoiceId)), ...(await writes('qbo', qboId))]
  expect(after).toEqual(before)
}

describe('V1, V2 notifications after a void', () => {
  it.each(['invoicing', 'qbo'] as const)('write nothing once voided in %s', async (side) => {
    // Given
    const given = await invoiceOf100()
    if (side === 'invoicing') await w.invoicing.voidInvoice(given.invoice.id, given.invoice.version)
    else await w.qboActor.voidInvoice(given.qboId)
    await w.sync()
    // When, Then
    await followUpWritesNothing(given.invoice.id, given.qboId, VOIDED_BOTH)
  })
})

describe('V4 delete in invoicing deletes in QBO', () => {
  it('deletes the QBO invoice and closes the link', async () => {
    // Given
    const given = await invoiceOf100()
    // When
    await w.invoicing.deleteInvoice(given.invoice.id, given.invoice.version)
    await w.sync()
    // Then
    expect(await w.qboActor.get('Invoice', given.qboId)).toBeNull()
    expect((await w.linkOf('invoice', 'qbo', given.qboId))!.deletedAt).not.toBeNull()
    expect(await writes('qbo', given.qboId)).toMatchObject([{ action: 'deleted', error: null }])
    expect(await w.issues()).toEqual([])

    // When QBO notifies about the invoice later
    const lastUpdated = w.clock.now().toISOString()
    await w.webhook('qbo', [{ name: 'Invoice', id: given.qboId, operation: 'Delete', lastUpdated }])
    await w.sync()
    // Then
    expect((await w.history('qbo', 'invoice', given.qboId)).at(-1)).toMatchObject({
      action: 'no_change',
    })
  })
})

describe('voided on one side, edited on the other', () => {
  it.each([
    ['invoicing', 'qbo'],
    ['qbo', 'invoicing'],
  ] as const)('voided in %s, edited in %s: flags a conflict', async (voidedIn, editedIn) => {
    // Given
    const given = await invoiceOf100()
    // When
    if (editedIn === 'invoicing') {
      await editInvoice(w, given.invoice.id, { memo: EDITED_MEMO })
      await w.qboActor.voidInvoice(given.qboId)
    } else {
      await w.qboActor.updateInvoice(given.qboId, { CustomerMemo: { value: EDITED_MEMO } })
      await w.invoicing.voidInvoice(given.invoice.id, given.invoice.version)
    }
    await w.sync()
    await followUpWritesNothing(
      given.invoice.id,
      given.qboId,
      voidedIn === 'invoicing'
        ? { invoicing: 'voided', qbo: 'Update' }
        : { invoicing: 'updated', qbo: 'Void' }
    )
    // Then
    expect(await w.issues()).toMatchObject([
      { kind: 'conflict', details: { reason: `voided in ${voidedIn}, changed in ${editedIn}` } },
    ])
    expect(await w.invoicing.getInvoice(given.invoice.id)).toMatchObject(
      voidedIn === 'invoicing' ? { status: 'void' } : { status: 'open', memo: EDITED_MEMO }
    )
    const qbo = (await w.qboActor.get('Invoice', given.qboId))!
    if (voidedIn === 'qbo') expect(qbo.PrivateNote).toMatch(/^Voided/)
    else expect(qbo).toMatchObject({ TotalAmt: 100, CustomerMemo: { value: EDITED_MEMO } })
    expect([
      ...(await writes('invoicing', given.invoice.id)),
      ...(await writes('qbo', given.qboId)),
    ]).toEqual([])
  })
})

describe('V7 deleted on one side, edited on the other', () => {
  it.each([
    ['invoicing', 'qbo'],
    ['qbo', 'invoicing'],
  ] as const)('deleted in %s, edited in %s: flags a conflict', async (deletedIn, editedIn) => {
    // Given
    const given = await invoiceOf100()
    // When
    if (editedIn === 'invoicing') {
      await editInvoice(w, given.invoice.id, { memo: EDITED_MEMO })
    } else {
      await w.qboActor.updateInvoice(given.qboId, { CustomerMemo: { value: EDITED_MEMO } })
    }
    if (deletedIn === 'invoicing') {
      const current = (await w.invoicing.getInvoice(given.invoice.id))!
      await w.invoicing.deleteInvoice(current.id, current.version)
    } else {
      await w.qboActor.deleteInvoice(given.qboId)
    }
    await w.sync()
    // Then
    expect(await w.issues()).toMatchObject([
      {
        kind: 'conflict',
        details: { reason: `deleted in ${deletedIn}, changed in ${editedIn}` },
      },
    ])
    if (editedIn === 'invoicing') {
      expect(await w.invoicing.getInvoice(given.invoice.id)).toMatchObject({
        memo: EDITED_MEMO,
        deletedAt: null,
      })
    } else {
      expect(await w.qboActor.get('Invoice', given.qboId)).toMatchObject({
        CustomerMemo: { value: EDITED_MEMO },
      })
    }
    expect((await w.linkOf('invoice', 'qbo', given.qboId))!.deletedAt).toBeNull()
    expect([
      ...(await writes('invoicing', given.invoice.id)),
      ...(await writes('qbo', given.qboId)),
    ]).toEqual([])
  })

  it('closes the conflict once the edited side is deleted too', async () => {
    // Given a conflict: deleted in QBO, edited in invoicing
    const given = await invoiceOf100()
    await editInvoice(w, given.invoice.id, { memo: EDITED_MEMO })
    await w.qboActor.deleteInvoice(given.qboId)
    await w.sync()
    // When
    const current = (await w.invoicing.getInvoice(given.invoice.id))!
    await w.invoicing.deleteInvoice(current.id, current.version)
    await w.sync()
    // Then
    expect(await w.issues()).toMatchObject([{ kind: 'conflict', resolution: 'converged' }])
    expect((await w.linkOf('invoice', 'qbo', given.qboId))!.deletedAt).not.toBeNull()
    expect(
      (await w.history('invoicing', 'invoice', given.invoice.id)).map((e) => e.action)
    ).toContain('issue_resolved')
  })

  it('a payment voided in QBO and edited in invoicing: flags a conflict', async () => {
    // Given
    const given = await invoiceOf100()
    const { payment, qboId } = await linkedPayment(w, given.invoice, '40.00')
    // When
    await w.invoicing.replacePayment(
      payment.id,
      {
        customerId: payment.customerId,
        amount: '40.00',
        date: '2026-01-06',
        allocations: [{ invoiceId: given.invoice.id, amount: '40.00' }],
      },
      payment.version
    )
    await w.qboActor.voidPayment(qboId)
    await w.sync()
    // Then
    expect(await w.issues()).toMatchObject([
      { kind: 'conflict', details: { reason: 'deleted in qbo, changed in invoicing' } },
    ])
    expect(await w.invoicing.getPayment(payment.id)).toMatchObject({
      date: '2026-01-06',
      deletedAt: null,
    })
    expect((await w.linkOf('payment', 'qbo', qboId))!.deletedAt).toBeNull()
  })
})

const jobStatuses = async () =>
  (await w.db.selectFrom('sync_jobs').select('status').execute()).map((j) => j.status)

const invoiceIssues = async () => (await w.issues()).filter((i) => i.ref.entityType === 'invoice')

describe('payments that the sync cannot free', () => {
  it('flags an invoice deleted in QBO whose payment is parked on its own conflict', async () => {
    // Given a linked payment dated differently in both systems
    const given = await invoiceOf100()
    const { payment, qboId } = await linkedPayment(w, given.invoice, '40.00')
    await w.invoicing.replacePayment(
      payment.id,
      {
        customerId: payment.customerId,
        amount: payment.amount,
        date: '2026-01-06',
        allocations: [{ invoiceId: given.invoice.id, amount: '40.00' }],
      },
      payment.version
    )
    await w.qboActor.updatePayment(qboId, {
      CustomerRef: { value: given.customer.qboId },
      TotalAmt: 40,
      TxnDate: '2026-01-07',
      Line: [{ Amount: 40, LinkedTxn: [{ TxnId: given.qboId, TxnType: 'Invoice' }] }],
    })
    await w.sync()
    // When
    await w.qboActor.deleteInvoice(given.qboId)
    await w.sync()
    // Then
    expect(await invoiceIssues()).toMatchObject([
      {
        kind: 'conflict',
        details: { reason: 'payments still allocated in invoicing', payments: [payment.id] },
      },
    ])
    expect(await w.invoicing.getInvoice(given.invoice.id)).toMatchObject({ deletedAt: null })
    expect(await w.invoicing.getPayment(payment.id)).toMatchObject({
      allocations: [{ invoiceId: given.invoice.id, amount: '40.00' }],
    })
    expect((await w.linkOf('invoice', 'qbo', given.qboId))!.deletedAt).toBeNull()
    expect(await jobStatuses()).not.toContain('failed')
  })

  it('flags an invoice voided in QBO that an unlinked payment is allocated to', async () => {
    // Given a payment recorded in invoicing whose notification was lost
    const given = await invoiceOf100()
    const payment = await w.invoicing.createPayment(
      {
        customerId: given.invoice.customerId,
        amount: '40.00',
        date: ISSUE_DATE,
        allocations: [{ invoiceId: given.invoice.id, amount: '40.00' }],
      },
      randomUUID()
    )
    await w.deliver({ drop: invoicingEvents('payment') })
    // When
    await w.qboActor.voidInvoice(given.qboId)
    await w.sync()
    // Then
    expect(await invoiceIssues()).toMatchObject([
      {
        kind: 'conflict',
        details: { reason: 'payments still allocated in invoicing', payments: [payment.id] },
      },
    ])
    expect(await w.invoicing.getInvoice(given.invoice.id)).toMatchObject({ status: 'partly_paid' })
    expect(await w.linkOf('payment', 'invoicing', payment.id)).toBeNull()
    const qboPayments = (await w.qbo.query('select * from Payment')).body as {
      QueryResponse: { Payment?: unknown[] }
    }
    expect(qboPayments.QueryResponse.Payment ?? []).toEqual([])
    expect(await jobStatuses()).not.toContain('failed')
  })
})
