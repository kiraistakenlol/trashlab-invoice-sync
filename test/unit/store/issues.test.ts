import { afterEach, beforeEach, expect, it } from 'vitest'
import { freshDb } from '../../harness/fresh-db.js'
import type { RecordRef } from '../../../src/db/database.js'
import { insertLink } from '../../../src/store/links.js'
import { getIssue, openIssue, openIssues, resolveIssue } from '../../../src/store/issues.js'

let t: Awaited<ReturnType<typeof freshDb>>
beforeEach(async () => {
  t = await freshDb()
})
afterEach(() => t.destroy())

const ref: RecordRef = { system: 'invoicing', entityType: 'invoice', entityId: 'i1' }

it('upserts the open issue of a kind for a link', async () => {
  const link = (await insertLink(t.db, 'invoice', { invoicingId: 'i1' }))!
  const first = await openIssue(t.db, { ref, linkId: link.id, kind: 'conflict', details: { a: 1 } })
  const second = await openIssue(t.db, {
    ref,
    linkId: link.id,
    kind: 'conflict',
    details: { a: 2 },
  })
  expect(second.id).toBe(first.id)
  expect(second.details).toEqual({ a: 2 })
  expect(await openIssues(t.db, { linkId: link.id })).toHaveLength(1)
})

it('upserts the open issue of a kind for an unlinked record', async () => {
  const first = await openIssue(t.db, { ref, linkId: null, kind: 'unsupported', details: { n: 1 } })
  const second = await openIssue(t.db, {
    ref,
    linkId: null,
    kind: 'unsupported',
    details: { n: 2 },
  })
  expect(second.id).toBe(first.id)
  expect(await openIssues(t.db, { ref })).toEqual([second])
})

it('opens a new issue after the previous one is resolved', async () => {
  const link = (await insertLink(t.db, 'invoice', { invoicingId: 'i1' }))!
  const first = await openIssue(t.db, { ref, linkId: link.id, kind: 'conflict', details: {} })
  await resolveIssue(t.db, first.id, 'qbo', new Date('2026-01-01T00:00:00Z'))
  expect(await openIssues(t.db, { linkId: link.id })).toEqual([])
  const second = await openIssue(t.db, { ref, linkId: link.id, kind: 'conflict', details: {} })
  expect(second.id).not.toBe(first.id)
  const resolved = await t.db
    .selectFrom('sync_issues')
    .selectAll()
    .where('id', '=', first.id)
    .executeTakeFirstOrThrow()
  expect(resolved).toMatchObject({
    resolution: 'qbo',
    resolved_at: new Date('2026-01-01T00:00:00Z'),
  })
})

it('resolves an issue once: a later resolution leaves the first in place', async () => {
  const first = await openIssue(t.db, { ref, linkId: null, kind: 'conflict', details: {} })
  expect(await resolveIssue(t.db, first.id, 'qbo', new Date('2026-01-01T00:00:00Z'))).toBe(true)
  expect(await resolveIssue(t.db, first.id, 'converged', new Date('2026-01-02T00:00:00Z'))).toBe(
    false
  )
  expect(await getIssue(t.db, first.id)).toMatchObject({
    resolution: 'qbo',
    resolvedAt: new Date('2026-01-01T00:00:00Z'),
  })
})
