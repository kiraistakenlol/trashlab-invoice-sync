// Invoice edits on either side (SCENARIOS.md U3, U5, U6).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { System } from '../../src/db/database.js'
import { createWorld, type World } from '../harness/world.js'
import { editInvoice, twoLineInvoice, type TwoLineInvoice } from './given.js'

const PAST_BACKOFF_MS = 1_000
const NEW_DUE_DATE = '2026-03-01'

let w: World
let given: TwoLineInvoice
beforeEach(async () => {
  w = await createWorld()
  given = await twoLineInvoice(w)
})
afterEach(() => w.close())

const updates = async (system: System, id: string) =>
  (await w.history(system, 'invoice', id)).filter((e) => e.action === 'updated')

const qboInvoice = async () => (await w.qboActor.get('Invoice', given.qboId))!
const invoice = async () => (await w.invoicing.getInvoice(given.invoice.id))!

describe("U3 the sync's own write is not echoed back", () => {
  it('finds nothing to do when QBO notifies about the write', async () => {
    // Given the sync has copied an invoicing edit to QBO
    const edited = await editInvoice(w, given.invoice.id, { memo: 'Gate code 1234' })
    await w.deliver()
    await w.drain()
    const syncToken = (await qboInvoice()).SyncToken
    // When
    await w.deliver()
    await w.drain()
    // Then
    expect((await qboInvoice()).SyncToken).toBe(syncToken)
    expect((await invoice()).version).toBe(edited.version)
    const history = (await w.history('qbo', 'invoice', given.qboId)).map((e) => e.action)
    expect(history.slice(-2)).toEqual(['notification_received', 'no_change'])
    expect(await updates('invoicing', given.invoice.id)).toEqual([])
  })

  it('echo before the link is stored: the retry finds both sides equal', async () => {
    // Given the QBO write is applied but its response lost
    const before = Number((await qboInvoice()).SyncToken)
    const edited = await editInvoice(w, given.invoice.id, { memo: 'Gate code 1234' })
    w.qbo.failNext({ method: 'POST', path: '/invoice' }, 'timeout_after_write')
    await w.deliver()
    await w.drain()
    // When QBO's notification of the write arrives before the retry
    await w.deliver()
    await w.clock.advance(PAST_BACKOFF_MS)
    await w.sync()
    // Then
    const qbo = await qboInvoice()
    expect(qbo.CustomerMemo).toEqual({ value: 'Gate code 1234' })
    expect(Number(qbo.SyncToken)).toBe(before + 1)
    expect((await invoice()).version).toBe(edited.version)
    expect((await updates('qbo', given.qboId)).map((e) => e.error)).toEqual([
      expect.stringMatching(/timeout/),
    ])
    expect(await updates('invoicing', given.invoice.id)).toEqual([])
    expect(await w.linkOf('invoice', 'invoicing', given.invoice.id)).toMatchObject({
      invoicingVersion: edited.version,
      qboSyncToken: qbo.SyncToken,
    })
    expect(await w.issues()).toEqual([])
  })
})

describe('U5 the other side changed under the sync write', () => {
  const STALE = expect.stringMatching(/5010|stale/i)
  const VERSION_CONFLICT = expect.stringMatching(/version/)

  it('QBO: a different field edited meanwhile is merged, not overwritten', async () => {
    // Given
    await editInvoice(w, given.invoice.id, { memo: 'Gate code 1234' })
    // When QBO is edited between the sync's read and its write
    w.hook(
      'qbo',
      { method: 'POST', path: '/invoice' },
      async () => {
        await w.qboActor.updateInvoice(given.qboId, { DueDate: NEW_DUE_DATE })
      },
      'before'
    )
    await w.sync()
    // Then
    expect(await qboInvoice()).toMatchObject({
      CustomerMemo: { value: 'Gate code 1234' },
      DueDate: NEW_DUE_DATE,
    })
    expect(await invoice()).toMatchObject({ memo: 'Gate code 1234', dueDate: NEW_DUE_DATE })
    expect((await updates('qbo', given.qboId)).map((e) => e.error)).toEqual([STALE, null])
    expect(await w.issues()).toEqual([])
  })

  it('QBO: the same field edited meanwhile becomes a conflict', async () => {
    // Given
    await editInvoice(w, given.invoice.id, { memo: 'Gate code 1234' })
    let hookToken: string | undefined
    // When
    w.hook(
      'qbo',
      { method: 'POST', path: '/invoice' },
      async () => {
        hookToken = (
          await w.qboActor.updateInvoice(given.qboId, { CustomerMemo: { value: 'Call ahead' } })
        ).SyncToken
      },
      'before'
    )
    await w.sync()
    // Then
    expect(await qboInvoice()).toMatchObject({
      CustomerMemo: { value: 'Call ahead' },
      SyncToken: hookToken,
    })
    expect((await invoice()).memo).toBe('Gate code 1234')
    expect((await updates('qbo', given.qboId)).map((e) => e.error)).toEqual([STALE])
    expect(await w.issues()).toMatchObject([
      { kind: 'conflict', details: { conflicts: [{ field: 'memo' }] } },
    ])
  })

  it('invoicing: a different field edited meanwhile is merged, not overwritten', async () => {
    // Given
    await w.qboActor.updateInvoice(given.qboId, { CustomerMemo: { value: 'Call ahead' } })
    // When invoicing is edited between the sync's read and its write
    w.hook(
      'invoicing',
      'replaceInvoice',
      async () => {
        await editInvoice(w, given.invoice.id, { dueDate: NEW_DUE_DATE })
      },
      'before'
    )
    await w.sync()
    // Then
    expect(await invoice()).toMatchObject({ memo: 'Call ahead', dueDate: NEW_DUE_DATE })
    expect(await qboInvoice()).toMatchObject({
      CustomerMemo: { value: 'Call ahead' },
      DueDate: NEW_DUE_DATE,
    })
    expect((await updates('invoicing', given.invoice.id)).map((e) => e.error)).toEqual([
      VERSION_CONFLICT,
      null,
    ])
    expect(await w.issues()).toEqual([])
  })

  it('invoicing: the same field edited meanwhile becomes a conflict', async () => {
    // Given
    await w.qboActor.updateInvoice(given.qboId, { CustomerMemo: { value: 'Call ahead' } })
    let hookVersion: number | undefined
    // When
    w.hook(
      'invoicing',
      'replaceInvoice',
      async () => {
        hookVersion = (await editInvoice(w, given.invoice.id, { memo: 'Gate code 1234' })).version
      },
      'before'
    )
    await w.sync()
    // Then
    expect(await invoice()).toMatchObject({ memo: 'Gate code 1234', version: hookVersion })
    expect((await qboInvoice()).CustomerMemo).toEqual({ value: 'Call ahead' })
    expect((await updates('invoicing', given.invoice.id)).map((e) => e.error)).toEqual([
      VERSION_CONFLICT,
    ])
    expect(await w.issues()).toMatchObject([
      { kind: 'conflict', details: { conflicts: [{ field: 'memo' }] } },
    ])
  })

  // the edit lands between the pair's read and the write's own re-read: the write still carries
  // the version the pair was read at
  it('QBO: an edit right after the read is not overwritten by the write', async () => {
    // Given
    await editInvoice(w, given.invoice.id, { memo: 'Gate code 1234' })
    // When
    w.hook(
      'qbo',
      { method: 'GET', path: `/invoice/${given.qboId}` },
      async () => {
        await w.qboActor.updateInvoice(given.qboId, { DueDate: NEW_DUE_DATE })
      },
      'after'
    )
    await w.sync()
    // Then
    expect(await qboInvoice()).toMatchObject({
      CustomerMemo: { value: 'Gate code 1234' },
      DueDate: NEW_DUE_DATE,
    })
    expect(await invoice()).toMatchObject({ memo: 'Gate code 1234', dueDate: NEW_DUE_DATE })
    expect((await updates('qbo', given.qboId)).map((e) => e.error)).toEqual([STALE, null])
    expect(await w.issues()).toEqual([])
  })

  it('invoicing: an edit right after the read is not overwritten by the write', async () => {
    // Given
    await w.qboActor.updateInvoice(given.qboId, { CustomerMemo: { value: 'Call ahead' } })
    // When
    w.hook(
      'invoicing',
      'getInvoice',
      async () => {
        await editInvoice(w, given.invoice.id, { dueDate: NEW_DUE_DATE })
      },
      'after'
    )
    await w.sync()
    // Then
    expect(await invoice()).toMatchObject({ memo: 'Call ahead', dueDate: NEW_DUE_DATE })
    expect(await qboInvoice()).toMatchObject({
      CustomerMemo: { value: 'Call ahead' },
      DueDate: NEW_DUE_DATE,
    })
    expect((await updates('invoicing', given.invoice.id)).map((e) => e.error)).toEqual([
      VERSION_CONFLICT,
      null,
    ])
    expect(await w.issues()).toEqual([])
  })
})

describe('U6 invoice number changed in QBO', () => {
  it('keeps the invoicing number and flags the invoice', async () => {
    // Given
    const before = await invoice()
    // When
    await w.qboActor.updateInvoice(given.qboId, { DocNumber: 'QBO-77' })
    await w.sync()
    // Then
    expect(await invoice()).toMatchObject({ number: before.number, version: before.version })
    const [issue] = await w.issues()
    expect(issue).toMatchObject({ kind: 'number_changed' })
    expect(await w.history('qbo', 'invoice', given.qboId)).toContainEqual(
      expect.objectContaining({
        action: 'issue_opened',
        details: { issueId: issue!.id, kind: 'number_changed' },
      })
    )
    expect(await updates('invoicing', given.invoice.id)).toEqual([])
  })
})
