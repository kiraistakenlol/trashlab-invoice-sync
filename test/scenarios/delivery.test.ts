// Notifications that are stale, duplicated, out of order or bunched (SCENARIOS.md E0, E1, E2, E3, E4, E6).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { System } from '../../src/db/database.js'
import { createWorld, type World } from '../harness/world.js'
import { editInvoice, twoLineInvoice, type TwoLineInvoice } from './given.js'

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

// notifications of edits to the invoice
const editsReceived = async () =>
  (await w.history('invoicing', 'invoice', given.invoice.id)).filter(
    (e) =>
      e.action === 'notification_received' && (e.details as { kind?: string }).kind === 'updated'
  )

const jobsOf = (system: System, entityId: string) =>
  w.db
    .selectFrom('sync_jobs')
    .select(['id', 'status'])
    .where('system', '=', system)
    .where('entity_type', '=', 'invoice')
    .where('entity_id', '=', entityId)
    .execute()

describe('E0 notifications are only a hint', () => {
  it('an invoicing event with an old version syncs the current invoice', async () => {
    // Given
    const first = await editInvoice(w, given.invoice.id, { memo: 'Gate code 1234' })
    await editInvoice(w, given.invoice.id, { memo: 'Gate code 9876', dueDate: NEW_DUE_DATE })
    w.invoicing.takeWebhooks()
    // When
    await w.webhook('invoicing', [
      {
        id: 'evt-stale',
        entityType: 'invoice',
        entityId: given.invoice.id,
        kind: 'updated',
        version: first.version,
      },
    ])
    await w.drain()
    // Then
    expect(await qboInvoice()).toMatchObject({
      CustomerMemo: { value: 'Gate code 9876' },
      DueDate: NEW_DUE_DATE,
    })
    expect(await updates('qbo', given.qboId)).toMatchObject([
      { error: null, changes: { memo: { to: 'Gate code 9876', source: 'invoicing' } } },
    ])
  })

  it("a QBO 'Delete' webhook for a live invoice syncs its edit and deletes nothing", async () => {
    // Given
    await w.qboActor.updateInvoice(given.qboId, { CustomerMemo: { value: 'Call ahead' } })
    w.qbo.takeWebhooks()
    // When
    await w.webhook('qbo', [
      {
        name: 'Invoice',
        id: given.qboId,
        operation: 'Delete',
        lastUpdated: w.clock.now().toISOString(),
      },
    ])
    await w.drain()
    // Then
    expect(await invoice()).toMatchObject({ memo: 'Call ahead', status: 'open', deletedAt: null })
    expect(await w.linkOf('invoice', 'qbo', given.qboId)).toMatchObject({ deletedAt: null })
    expect(await updates('invoicing', given.invoice.id)).toMatchObject([
      { error: null, changes: { memo: { to: 'Call ahead', source: 'qbo' } } },
    ])
    expect((await w.history('qbo', 'invoice', given.qboId)).map((e) => e.action)).not.toContain(
      'deleted'
    )
  })
})

describe('E1 duplicate webhook', () => {
  it('writes the change once when the duplicate arrives with the original', async () => {
    // Given
    const before = Number((await qboInvoice()).SyncToken)
    await editInvoice(w, given.invoice.id, { memo: 'Gate code 1234' })
    // When
    await w.deliver({ duplicate: true })
    await w.sync()
    // Then
    expect(Number((await qboInvoice()).SyncToken)).toBe(before + 1)
    expect(await updates('qbo', given.qboId)).toHaveLength(1)
    expect(await editsReceived()).toHaveLength(2)
  })

  it('finds nothing to do when the same event is delivered again after the sync', async () => {
    // Given a change already synced
    await editInvoice(w, given.invoice.id, { memo: 'Gate code 1234' })
    const [event] = w.invoicing.takeWebhooks()
    await w.webhook('invoicing', [event!])
    await w.sync()
    const syncToken = (await qboInvoice()).SyncToken
    const earlier = (await jobsOf('invoicing', given.invoice.id)).map((j) => j.id)
    // When
    await w.webhook('invoicing', [event!])
    await w.sync()
    // Then
    const [redelivered, ...more] = (await jobsOf('invoicing', given.invoice.id)).filter(
      (j) => !earlier.includes(j.id)
    )
    expect(more).toEqual([])
    expect(redelivered).toMatchObject({ status: 'done' })
    const last = (await w.history('invoicing', 'invoice', given.invoice.id)).at(-1)
    expect(last).toMatchObject({ action: 'no_change', error: null, jobId: redelivered!.id })
    expect((await qboInvoice()).SyncToken).toBe(syncToken)
    expect(await updates('qbo', given.qboId)).toHaveLength(1)
  })
})

describe('E3 events out of order', () => {
  it('ends with state B; the late event for A changes nothing', async () => {
    // Given edits A then B
    await editInvoice(w, given.invoice.id, { memo: 'A' })
    const b = await editInvoice(w, given.invoice.id, { memo: 'B', dueDate: NEW_DUE_DATE })
    const [eventA, eventB] = w.invoicing.takeWebhooks()
    // When B's notification is processed before A's
    await w.webhook('invoicing', [eventB!])
    await w.sync()
    const syncToken = (await qboInvoice()).SyncToken
    await w.webhook('invoicing', [eventA!])
    await w.sync()
    // Then
    expect(await qboInvoice()).toMatchObject({
      CustomerMemo: { value: 'B' },
      DueDate: NEW_DUE_DATE,
      SyncToken: syncToken,
    })
    expect((await invoice()).version).toBe(b.version)
    expect(await updates('qbo', given.qboId)).toHaveLength(1)
    const last = (await w.history('invoicing', 'invoice', given.invoice.id)).at(-1)
    expect(last).toMatchObject({ action: 'no_change', error: null })
  })
})

describe('E6 many events for one invoice at once', () => {
  it('runs one job for the bunch and ends at the last edit', async () => {
    // Given
    const before = (await jobsOf('invoicing', given.invoice.id)).length
    for (const n of [1, 2, 3, 4, 5]) {
      await editInvoice(w, given.invoice.id, { memo: `Note ${n}` })
    }
    // When
    await w.deliver()
    // Then
    const pending = (await jobsOf('invoicing', given.invoice.id)).filter(
      (j) => j.status === 'pending'
    )
    expect(pending).toHaveLength(1)
    await w.sync()
    expect(await jobsOf('invoicing', given.invoice.id)).toHaveLength(before + 1)
    expect((await qboInvoice()).CustomerMemo).toEqual({ value: 'Note 5' })
    expect(await updates('qbo', given.qboId)).toMatchObject([
      { error: null, changes: { memo: { to: 'Note 5', source: 'invoicing' } } },
    ])
    expect(await editsReceived()).toHaveLength(5)
  })
})

describe('E2 same change seen by webhook and by polling', () => {
  it('writes an invoicing edit once', async () => {
    // Given
    await editInvoice(w, given.invoice.id, { memo: 'Gate code 1234' })
    await w.sync()
    const syncToken = (await qboInvoice()).SyncToken
    // When
    await w.poll()
    await w.drain()
    // Then
    expect((await qboInvoice()).SyncToken).toBe(syncToken)
    expect(await updates('qbo', given.qboId)).toHaveLength(1)
  })

  it('writes a QBO edit once', async () => {
    // Given
    await w.qboActor.updateInvoice(given.qboId, { CustomerMemo: { value: 'Call ahead' } })
    await w.sync()
    const version = (await invoice()).version
    // When
    await w.poll()
    await w.drain()
    // Then
    expect((await invoice()).version).toBe(version)
    expect(await updates('invoicing', given.invoice.id)).toHaveLength(1)
  })
})

describe('E4 lost webhook', () => {
  it('syncs an invoicing edit found in the events feed', async () => {
    // Given
    await editInvoice(w, given.invoice.id, { memo: 'Gate code 1234' })
    await w.deliver({ drop: () => true })
    // When
    await w.poll()
    await w.drain()
    // Then
    expect((await qboInvoice()).CustomerMemo).toEqual({ value: 'Gate code 1234' })
  })

  it('syncs a QBO edit found by change data capture', async () => {
    // Given
    await w.qboActor.updateInvoice(given.qboId, { CustomerMemo: { value: 'Call ahead' } })
    await w.deliver({ drop: () => true })
    // When
    w.clock.advance(1000)
    await w.poll()
    await w.drain()
    // Then
    expect((await invoice()).memo).toBe('Call ahead')
  })
})
