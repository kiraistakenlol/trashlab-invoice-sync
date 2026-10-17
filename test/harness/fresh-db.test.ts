import { sql } from 'kysely'
import { expect, it } from 'vitest'
import { freshDb } from './fresh-db.js'

it('has the baseline schema', async () => {
  const { db, destroy } = await freshDb()
  const tables = await sql<{
    t: string
  }>`select tablename as t from pg_tables where schemaname = 'public' order by 1`.execute(db)
  expect(tables.rows.map((r) => r.t)).toEqual([
    'audit_log',
    'invoicing_qbo_links',
    'poll_cursors',
    'sync_issues',
    'sync_jobs',
  ])
  await destroy()
})

it('isolates databases', async () => {
  const a = await freshDb()
  const b = await freshDb()
  await a.db.insertInto('poll_cursors').values({ system: 'qbo', cursor: 'x' }).execute()
  expect(await b.db.selectFrom('poll_cursors').selectAll().execute()).toEqual([])
  await a.destroy()
  await b.destroy()
})

it('creates two fresh databases in parallel', async () => {
  const [a, b] = await Promise.all([freshDb(), freshDb()])
  await Promise.all([a.destroy(), b.destroy()])
})
