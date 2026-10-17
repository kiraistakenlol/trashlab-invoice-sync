// freshDb(): a new database cloned from the template, dropped on destroy.
import { randomBytes } from 'node:crypto'
import type { Kysely } from 'kysely'
import pg from 'pg'
import { inject } from 'vitest'
import { createDb } from '../../src/db/create-db.js'
import type { Database } from '../../src/db/database.js'
import { eventually } from './eventually.js'
import { TEMPLATE_DB } from './provided.js'

async function withAdmin<T>(run: (admin: pg.Client) => Promise<T>): Promise<T> {
  const admin = new pg.Client({ connectionString: inject('pgAdminUrl') })
  await admin.connect()
  try {
    return await run(admin)
  } finally {
    await admin.end()
  }
}

export async function freshDb(): Promise<{ db: Kysely<Database>; destroy(): Promise<void> }> {
  const name = `t_${randomBytes(6).toString('hex')}`
  await withAdmin((admin) => admin.query(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE_DB}`))

  const url = new URL(inject('pgAdminUrl'))
  url.pathname = `/${name}`
  const db = createDb(url.toString())

  return {
    db,
    async destroy() {
      await db.destroy()
      await withAdmin(async (admin) => {
        // The pool's end resolves before its connections close; a forced drop would
        // terminate the stragglers and their clients would raise 57P01.
        await eventually(
          async () =>
            (
              await admin.query<{ n: number }>(
                'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1',
                [name]
              )
            ).rows[0]!.n,
          (n) => n === 0,
          { intervalMs: 10 }
        )
        await admin.query(`DROP DATABASE ${name} WITH (FORCE)`)
      })
    },
  }
}
