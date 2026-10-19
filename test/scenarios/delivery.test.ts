// Notifications that are stale, duplicated, out of order or bunched (SCENARIOS.md E0, E2, E3, E4, E6).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { System } from '../../src/db/database.js'
import { signQboWebhook } from '../../src/qbo/webhooks.js'
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
    await w.clock.advance(1000)
    await w.poll()
    await w.drain()
    // Then
    expect((await invoice()).memo).toBe('Call ahead')
  })
})

describe('E3a delayed notification', () => {
  it('writes nothing when the change was already synced by polling', async () => {
    // Given a change synced by polling
    await editInvoice(w, given.invoice.id, { memo: 'Gate code 1234' })
    const [event] = w.invoicing.takeWebhooks()
    await w.poll()
    await w.drain()
    const syncToken = (await qboInvoice()).SyncToken
    // When its webhook arrives afterwards
    await w.webhook('invoicing', [event!])
    await w.drain()
    // Then
    expect((await qboInvoice()).SyncToken).toBe(syncToken)
    expect(await updates('qbo', given.qboId)).toHaveLength(1)
    const last = (await w.history('invoicing', 'invoice', given.invoice.id)).at(-1)
    expect(last).toMatchObject({ action: 'no_change', error: null })
  })
})

describe('E5 created and deleted before the sync runs', () => {
  it('creates nothing in invoicing', async () => {
    // Given
    const customerId = (await w.linkOf('customer', 'invoicing', given.invoice.customerId))!.qboId!
    const created = await w.qboActor.createInvoice(
      customerId,
      [{ amount: '40.00', itemId: given.pickup.qboId }],
      { DocNumber: 'Q-1' }
    )
    await w.qboActor.deleteInvoice(created.Id)
    // When both notifications are processed
    await w.sync()
    // Then
    expect(await w.invoicing.listInvoices()).toHaveLength(1)
    expect(await w.linkOf('invoice', 'qbo', created.Id)).toBeNull()
    expect(await w.issues()).toEqual([])
  })
})

describe('E7 forged notification is rejected', () => {
  it('answers 401 and queues and audits nothing', async () => {
    // Given
    const count = async () => ({
      jobs: (await w.db.selectFrom('sync_jobs').select('id').execute()).length,
      audit: (await w.db.selectFrom('audit_log').select('id').execute()).length,
    })
    const before = await count()
    const body = JSON.stringify({
      eventNotifications: [
        {
          realmId: '9130000000000000',
          dataChangeEvent: {
            entities: [
              {
                name: 'Invoice',
                id: given.qboId,
                operation: 'Update',
                lastUpdated: w.clock.now().toISOString(),
              },
            ],
          },
        },
      ],
    })
    // When
    const res = await w.server.inject({
      method: 'POST',
      url: '/webhooks/qbo',
      payload: body,
      headers: {
        'content-type': 'application/json',
        'intuit-signature': signQboWebhook(body, 'not-the-verifier-token'),
      },
    })
    // Then
    expect(res.statusCode).toBe(401)
    expect(res.json()).toMatchObject({ error: { code: 'invalid_signature' } })
    expect(await count()).toEqual(before)
  })
})

describe('G3 manual journal entries in QBO are ignored', () => {
  it('acknowledges the webhook and queues and audits nothing', async () => {
    // Given
    const count = async () => ({
      jobs: (await w.db.selectFrom('sync_jobs').select('id').execute()).length,
      audit: (await w.db.selectFrom('audit_log').select('id').execute()).length,
    })
    const before = await count()
    // When
    await w.webhook('qbo', [
      {
        name: 'JournalEntry',
        id: '501',
        operation: 'Create',
        lastUpdated: w.clock.now().toISOString(),
      },
    ])
    // Then
    expect(await count()).toEqual(before)
  })
})
