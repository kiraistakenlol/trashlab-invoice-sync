// Voids and deletes across systems (SCENARIOS.md V1, V2, V4, V5, V7).
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { System } from '../../src/db/database.js'
import { createWorld, type World } from '../harness/world.js'
import { editInvoice, linkedCustomer, linkedInvoice, linkedItem, linkedPayment } from './given.js'

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

// both systems notify about the invoice again; nothing may be written on either side
async function followUpWritesNothing(invoiceId: string, qboId: string): Promise<void> {
  const before = [...(await writes('invoicing', invoiceId)), ...(await writes('qbo', qboId))]
  const qbo = (await w.qboActor.get('Invoice', qboId))!
  const lastUpdated = qbo.MetaData.LastUpdatedTime
  await w.webhook('qbo', [{ name: 'Invoice', id: qboId, operation: 'Update', lastUpdated }])
  const { version } = (await w.invoicing.getInvoice(invoiceId))!
  await w.webhook('invoicing', [
    { id: randomUUID(), entityType: 'invoice', entityId: invoiceId, kind: 'voided', version },
  ])
  await w.sync()
  const after = [...(await writes('invoicing', invoiceId)), ...(await writes('qbo', qboId))]
  expect(after).toEqual(before)
}

describe('V1 void in invoicing voids in QBO', () => {
  it('voids the QBO invoice and audits it as voided', async () => {
    // Given
    const given = await invoiceOf100()
    // When
    await w.invoicing.voidInvoice(given.invoice.id, given.invoice.version)
    await w.sync()
    // Then
    const qbo = (await w.qboActor.get('Invoice', given.qboId))!
    expect(qbo.PrivateNote).toMatch(/^Voided/)
    expect(qbo.TotalAmt).toBe(0)
    expect(await writes('qbo', given.qboId)).toMatchObject([
      { action: 'voided', error: null, changes: { voided: { to: true, source: 'invoicing' } } },
    ])
    expect(await w.issues()).toEqual([])
    await followUpWritesNothing(given.invoice.id, given.qboId)
  })
})

describe('V2 void in QBO voids in invoicing', () => {
  it('voids the invoicing invoice, which keeps its lines', async () => {
    // Given
    const given = await invoiceOf100()
    // When
    await w.qboActor.voidInvoice(given.qboId)
    await w.sync()
    // Then
    expect(await w.invoicing.getInvoice(given.invoice.id)).toMatchObject({
      status: 'void',
      total: '100.00',
    })
    expect(await writes('invoicing', given.invoice.id)).toMatchObject([
      { action: 'voided', error: null, changes: { voided: { to: true, source: 'qbo' } } },
    ])
    expect(await w.issues()).toEqual([])
    await followUpWritesNothing(given.invoice.id, given.qboId)
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

describe('V5 delete in QBO deletes in invoicing', () => {
  it('removes the allocation from the payment first, then deletes the invoice', async () => {
    // Given
    const given = await invoiceOf100()
    const { payment } = await linkedPayment(w, given.invoice, '40.00')
    // When
    await w.qboActor.deleteInvoice(given.qboId)
    await w.sync()
    // Then
    expect((await w.invoicing.getInvoice(given.invoice.id))!.deletedAt).not.toBeNull()
    expect(await w.invoicing.getPayment(payment.id)).toMatchObject({
      amount: '40.00',
      unapplied: '40.00',
      allocations: [],
      deletedAt: null,
    })
    const freed = (await w.history('invoicing', 'payment', payment.id)).find(
      (e) => e.action === 'updated'
    )
    const deleted = (await writes('invoicing', given.invoice.id)).find(
      (e) => e.action === 'deleted'
    )
    expect(freed).toMatchObject({ error: null, changes: { allocations: { to: [] } } })
    expect(deleted).toMatchObject({ error: null })
    expect(Number(freed!.id)).toBeLessThan(Number(deleted!.id))
    expect((await w.linkOf('invoice', 'qbo', given.qboId))!.deletedAt).not.toBeNull()
    expect(await w.issues()).toEqual([])
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
    await followUpWritesNothing(given.invoice.id, given.qboId)
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
