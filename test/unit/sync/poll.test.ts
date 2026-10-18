import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getCursor, setCursor } from '../../../src/store/cursors.js'
import { CDC_MAX_PER_ENTITY, QboApi } from '../../../src/qbo/api.js'
import type { SyncContext } from '../../../src/sync/context.js'
import { pollInvoicing, pollQbo } from '../../../src/sync/poll.js'
import { createWorld, type World } from '../../harness/world.js'

let w: World
beforeEach(async () => {
  w = await createWorld()
})
afterEach(() => w.close())

const jobs = (system: 'invoicing' | 'qbo') =>
  w.db.selectFrom('sync_jobs').select('id').where('system', '=', system).execute()

describe('pollInvoicing', () => {
  it('reads new events, advances the cursor and reads nothing twice', async () => {
    // Given
    const customer = await w.invoicing.createCustomer({ name: 'Acme' }, 'key-1')
    // When
    const first = await pollInvoicing(w.ctx)
    const second = await pollInvoicing(w.ctx)
    // Then
    expect(first).toBe(1)
    expect(second).toBe(0)
    expect(await getCursor(w.db, 'invoicing')).not.toBeNull()
    expect(await jobs('invoicing')).toHaveLength(1)
    expect(await w.history('invoicing', 'customer', customer.id)).toMatchObject([
      { action: 'notification_received', details: { source: 'feed', kind: 'created' } },
    ])
  })
})

describe('pollInvoicing batches', () => {
  it('reads every page and ends the cursor at the last event', async () => {
    // Given
    for (let n = 0; n < 101; n++) await w.invoicing.createCustomer({ name: `C${n}` }, `key-${n}`)
    const last = (await w.invoicing.listEvents(null, 1000)).at(-1)!
    // When
    const count = await pollInvoicing(w.ctx)
    // Then
    expect(count).toBe(101)
    expect(await getCursor(w.db, 'invoicing')).toBe(last.id)
    expect(await jobs('invoicing')).toHaveLength(101)
  })

  it('leaves the cursor and the audit untouched when a notify fails mid-batch', async () => {
    // Given
    const a = await w.invoicing.createCustomer({ name: 'A' }, 'key-a')
    await w.invoicing.createCustomer({ name: 'B' }, 'key-b')
    let calls = 0
    const ctx: SyncContext = {
      ...w.ctx,
      clock: {
        now: () => {
          if (++calls === 2) throw new Error('boom')
          return w.clock.now()
        },
      },
    }
    // When
    await expect(pollInvoicing(ctx)).rejects.toThrow('boom')
    // Then
    expect(await getCursor(w.db, 'invoicing')).toBeNull()
    expect(await jobs('invoicing')).toHaveLength(0)
    expect(await w.history('invoicing', 'customer', a.id)).toEqual([])
  })
})

describe('pollQbo', () => {
  it('stores now and reports nothing when there is no cursor', async () => {
    // Given
    await w.db.deleteFrom('poll_cursors').execute()
    // When
    const count = await pollQbo(w.ctx)
    // Then
    expect(count).toBe(0)
    expect(await getCursor(w.db, 'qbo')).toBe(w.clock.now().toISOString())
  })

  it('moves the cursor to the request time and sees repeats as no change', async () => {
    // Given
    const customer = await w.qboActor.createCustomer('Acme')
    w.qbo.takeWebhooks()
    const before = await getCursor(w.db, 'qbo')
    await w.clock.advance(3_000)
    // When
    const first = await pollQbo(w.ctx)
    await w.drain()
    const afterFirst = await getCursor(w.db, 'qbo')
    await w.clock.advance(1_000) // the step-back window still reaches the change
    const second = await pollQbo(w.ctx)
    await w.drain()
    // Then
    expect(first).toBeGreaterThan(0)
    expect(afterFirst).not.toBe(before)
    expect(afterFirst).toBe('2026-01-05T10:00:03.000Z')
    expect(await getCursor(w.db, 'qbo')).toBe('2026-01-05T10:00:04.000Z')
    expect(second).toBeGreaterThan(0)
    expect((await w.history('qbo', 'customer', customer.Id)).at(-1)).toMatchObject({
      action: 'no_change',
    })
  })

  it('does not follow a future-dated record and still sees later changes', async () => {
    // Given
    const future = await w.qboActor.createCustomer('Future')
    w.qbo.setUpdatedAt('Customer', future.Id, new Date('2026-11-19T00:00:00Z'))
    await w.clock.advance(10_000)
    // When
    await pollQbo(w.ctx)
    await w.drain()
    const cursor = (await getCursor(w.db, 'qbo'))!
    await w.clock.advance(10_000)
    const later = await w.qboActor.createCustomer('Later')
    w.qbo.takeWebhooks()
    await pollQbo(w.ctx)
    // Then
    expect(new Date(cursor).getTime()).toBeLessThanOrEqual(Date.parse('2026-01-05T10:00:10Z'))
    expect(await w.history('qbo', 'customer', later.Id)).toMatchObject([
      { action: 'notification_received', details: { source: 'cdc' } },
    ])
  })

  it('never moves a cursor stored ahead of the request time backward', async () => {
    // Given
    const ahead = '2026-02-01T00:00:00.000Z'
    await setCursor(w.db, 'qbo', ahead)
    // When
    await pollQbo(w.ctx)
    // Then
    expect(await getCursor(w.db, 'qbo')).toBe(ahead)
  })

  it('holds the cursor at the last update of a capped entity', async () => {
    // Given
    const rows = Array.from({ length: CDC_MAX_PER_ENTITY }, (_, i) => ({
      Id: String(i),
      MetaData: { LastUpdatedTime: `2026-01-05T10:00:0${i % 5}.000Z` },
    }))
    const request = async () => ({
      status: 200,
      intuitTid: null,
      body: {
        CDCResponse: [{ QueryResponse: [{ Customer: rows }, { Invoice: [] }] }],
      },
    })
    const ctx: SyncContext = {
      ...w.ctx,
      qbo: new QboApi({ request, query: request } as never),
    }
    await w.clock.advance(60_000)
    // When
    const count = await pollQbo(ctx)
    // Then
    expect(count).toBe(CDC_MAX_PER_ENTITY)
    expect(await getCursor(w.db, 'qbo')).toBe('2026-01-05T10:00:04.000Z')
  })

  it('picks up a record changed within the second of the cursor', async () => {
    // Given
    await w.clock.advance(500)
    const customer = await w.qboActor.createCustomer('Acme')
    await setCursor(w.db, 'qbo', w.clock.now().toISOString())
    // When
    const count = await pollQbo(w.ctx)
    // Then
    expect(count).toBeGreaterThan(0)
    expect(await w.history('qbo', 'customer', customer.Id)).toMatchObject([
      { action: 'notification_received', details: { source: 'cdc', deleted: false } },
    ])
  })
})
