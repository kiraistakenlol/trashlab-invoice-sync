import { afterEach, beforeEach, expect, it } from 'vitest'
import { freshDb } from '../../harness/fresh-db.js'
import type { RecordRef } from '../../../src/db/database.js'
import { audit, auditHistory } from '../../../src/store/audit.js'

let t: Awaited<ReturnType<typeof freshDb>>
beforeEach(async () => {
  t = await freshDb()
})
afterEach(() => t.destroy())

const a: RecordRef = { system: 'qbo', entityType: 'invoice', entityId: '1' }
const b: RecordRef = { system: 'invoicing', entityType: 'invoice', entityId: '1' }

it('returns only the record rows, in insertion order', async () => {
  await audit(t.db, { ref: a, action: 'notification_received', details: { op: 'Update' } })
  await audit(t.db, { ref: b, action: 'notification_received' })
  await audit(t.db, {
    ref: a,
    action: 'updated',
    changes: { total: { from: '1.00', to: '2.00', source: 'qbo' } },
  })
  const rows = await auditHistory(t.db, a)
  expect(rows.map((r) => r.action)).toEqual(['notification_received', 'updated'])
  expect(rows[0]!.details).toEqual({ op: 'Update' })
  expect(rows[1]!.changes).toEqual({ total: { from: '1.00', to: '2.00', source: 'qbo' } })
})

it('stores an absent error as null and keeps a given one', async () => {
  await audit(t.db, { ref: a, action: 'created' })
  await audit(t.db, { ref: a, action: 'created', error: 'boom' })
  expect((await auditHistory(t.db, a)).map((r) => r.error)).toEqual([null, 'boom'])
})
