import { afterEach, beforeEach, expect, it } from 'vitest'
import { freshDb } from '../../harness/fresh-db.js'
import {
  findLink,
  getLink,
  insertLink,
  pendingLinks,
  updateLink,
} from '../../../src/store/links.js'

let t: Awaited<ReturnType<typeof freshDb>>
beforeEach(async () => {
  t = await freshDb()
})
afterEach(() => t.destroy())

it('rejects a second link for the same QBO record', async () => {
  expect(await insertLink(t.db, 'customer', { qboId: '7' })).not.toBeNull()
  expect(await insertLink(t.db, 'customer', { qboId: '7', invoicingId: 'c1' })).toBeNull()
})

it('finds a link by either side id', async () => {
  const link = await insertLink(t.db, 'invoice', { invoicingId: 'i1' })
  expect(await findLink(t.db, 'invoice', 'invoicing', 'i1')).toEqual(link)
  expect(await findLink(t.db, 'invoice', 'qbo', 'i1')).toBeNull()
  expect(await findLink(t.db, 'customer', 'invoicing', 'i1')).toBeNull()
})

it('updates only the version it read', async () => {
  const first = (await insertLink(t.db, 'invoice', { invoicingId: 'i1' }))!
  const second = await updateLink(t.db, first, { qboId: '9', qboSyncToken: '0' })
  expect(second).toMatchObject({ qboId: '9', qboSyncToken: '0', version: 2 })

  expect(await updateLink(t.db, first, { qboId: '10' })).toBeNull()
  expect(await getLink(t.db, first.id)).toEqual(second)
})

it('keeps the create idempotency key across updates', async () => {
  const first = (await insertLink(t.db, 'invoice', { invoicingId: 'i1' }))!
  expect(first.createIdempotencyKey).toMatch(/^[0-9a-f-]{36}$/)
  const second = (await updateLink(t.db, first, {
    snapshot: { total: '1.00' },
    invoicingVersion: 3,
    deletedAt: new Date('2026-01-01T00:00:00Z'),
  }))!
  expect(second.createIdempotencyKey).toBe(first.createIdempotencyKey)
  expect(second.snapshot).toEqual({ total: '1.00' })
  expect(second.invoicingVersion).toBe(3)
  expect(second.deletedAt).toEqual(new Date('2026-01-01T00:00:00Z'))
})

it('returns null when an update would link a record twice', async () => {
  await insertLink(t.db, 'customer', { qboId: '7' })
  const half = (await insertLink(t.db, 'customer', { invoicingId: 'c1' }))!
  expect(await updateLink(t.db, half, { qboId: '7' })).toBeNull()
})

it('lists half links with pending fields that miss the given side', async () => {
  const pending = (await insertLink(t.db, 'customer', { qboId: '7' }))!
  const withFields = (await updateLink(t.db, pending, { snapshot: { name: 'Acme' } }))!
  await insertLink(t.db, 'customer', { qboId: '8' })
  await insertLink(t.db, 'customer', { invoicingId: 'c1' })
  expect(await pendingLinks(t.db, 'customer', 'invoicing')).toEqual([withFields])
  expect(await pendingLinks(t.db, 'item', 'invoicing')).toEqual([])
})
