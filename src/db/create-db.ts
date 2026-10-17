// Kysely instance over a pg connection pool.
import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import type { Database } from './database.js'

export function createDb(connectionString: string): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 5 }) }),
  })
}
