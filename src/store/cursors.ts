// poll_cursors repository: where polling resumes, per system.
import type { Kysely } from 'kysely'
import type { Database, System } from '../db/database.js'

export async function getCursor(db: Kysely<Database>, system: System): Promise<string | null> {
  const row = await db
    .selectFrom('poll_cursors')
    .select('cursor')
    .where('system', '=', system)
    .executeTakeFirst()
  return row?.cursor ?? null
}

export async function setCursor(
  db: Kysely<Database>,
  system: System,
  cursor: string
): Promise<void> {
  await db
    .insertInto('poll_cursors')
    .values({ system, cursor })
    .onConflict((oc) => oc.column('system').doUpdateSet({ cursor }))
    .execute()
}
