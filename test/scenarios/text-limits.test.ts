// Text too long for QBO is flagged, not sent (SCENARIOS.md U8).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createWorld, type World } from '../harness/world.js'
import {
  DUE_DATE,
  editInvoice,
  ISSUE_DATE,
  linkedCustomer,
  linkedInvoice,
  linkedItem,
} from './given.js'

const LONG_MEMO = 'm'.repeat(1500)
const MAX_MEMO = 'm'.repeat(1000)

let w: World
beforeEach(async () => {
  w = await createWorld()
})
afterEach(() => w.close())

const memoIssue = {
  kind: 'unsupported',
  details: {
    reason: 'CustomerMemo is 1500 characters; QBO allows at most 1000',
    field: 'CustomerMemo',
    length: 1500,
    max: 1000,
  },
}

describe('new invoicing invoice with a memo too long for QBO', () => {
  it('is flagged and not created in QBO', async () => {
    // Given
    const { customer } = await linkedCustomer(w, 'Acme')
    const { item } = await linkedItem(w, 'Pickup', 'Hauling')
    // When
    const invoice = await w.invoicing.createInvoice(
      {
        customerId: customer.id,
        issueDate: ISSUE_DATE,
        dueDate: DUE_DATE,
        memo: LONG_MEMO,
        lines: [{ itemId: item.id, quantity: '1', unitPrice: '15.00', amount: '15.00' }],
      },
      'long-memo'
    )
    await w.sync()
    // Then
    expect(await w.issues()).toMatchObject([memoIssue])
    expect((await w.linkOf('invoice', 'invoicing', invoice.id))?.qboId ?? null).toBeNull()
    const res = await w.qbo.query('select * from Invoice')
    expect(
      (res.body as { QueryResponse: { Invoice?: unknown[] } }).QueryResponse.Invoice ?? []
    ).toEqual([])
  })
})

describe('linked invoice whose memo grows too long in invoicing', () => {
  it('is flagged and QBO keeps the old memo', async () => {
    // Given
    const { item } = await linkedItem(w, 'Pickup', 'Hauling')
    const { invoice, qboId } = await linkedInvoice(w, {
      memo: 'short',
      lines: [{ itemId: item.id, quantity: '1', unitPrice: '15.00', amount: '15.00' }],
    })
    // When
    await editInvoice(w, invoice.id, { memo: LONG_MEMO })
    await w.sync()
    // Then
    expect(await w.issues()).toMatchObject([memoIssue])
    expect(await w.qboActor.get('Invoice', qboId)).toMatchObject({
      CustomerMemo: { value: 'short' },
    })
  })

  it('closes by itself once both sides carry the same shortened memo', async () => {
    // Given
    const { invoice, qboId } = await longMemoFlagged()
    // When
    await editInvoice(w, invoice.id, { memo: MAX_MEMO })
    await w.qboActor.updateInvoice(qboId, { CustomerMemo: { value: MAX_MEMO } })
    await w.sync()
    // Then
    expect(await w.issues()).toMatchObject([{ resolution: 'converged' }])
  })
})

async function longMemoFlagged() {
  const { item } = await linkedItem(w, 'Pickup', 'Hauling')
  const linked = await linkedInvoice(w, {
    memo: 'short',
    lines: [{ itemId: item.id, quantity: '1', unitPrice: '15.00', amount: '15.00' }],
  })
  await editInvoice(w, linked.invoice.id, { memo: LONG_MEMO })
  await w.sync()
  return linked
}
