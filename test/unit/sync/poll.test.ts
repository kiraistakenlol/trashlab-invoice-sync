import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getCursor, setCursor } from '../../../src/store/cursors.js'
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

  it('advances the cursor to the latest change and sees repeats as no change', async () => {
    // Given
    const customer = await w.qboActor.createCustomer('Acme')
    w.qbo.takeWebhooks()
    w.clock.advance(10_000)
    // When
    const first = await pollQbo(w.ctx)
    await w.drain()
    const second = await pollQbo(w.ctx)
    await w.drain()
    // Then
    expect(first).toBeGreaterThan(0)
    expect(await getCursor(w.db, 'qbo')).toBe('2026-01-05T10:00:00.000Z')
    expect(second).toBeGreaterThan(0)
    expect((await w.history('qbo', 'customer', customer.Id)).at(-1)).toMatchObject({
      action: 'no_change',
    })
  })

  it('picks up a record changed within the second of the cursor', async () => {
    // Given
    w.clock.advance(500)
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
