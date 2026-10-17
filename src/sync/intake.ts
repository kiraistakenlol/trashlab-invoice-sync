// Turns a change notification into a queued job and an audit entry, atomically.
import type { Kysely } from 'kysely'
import { ENTITY_TYPES, type Database, type EntityType, type RecordRef } from '../db/database.js'
import { audit } from '../store/audit.js'
import { enqueue } from '../store/jobs.js'
import type { SyncContext } from './context.js'

export const entityTypeOfQbo = (name: string): EntityType | undefined =>
  ENTITY_TYPES.find((t) => t === name.toLowerCase())

// Runs on the given handle, so a caller can bundle it into a larger transaction.
export async function notifyIn(
  db: Kysely<Database>,
  ctx: SyncContext,
  ref: RecordRef,
  details: object
): Promise<void> {
  await audit(db, { ref, action: 'notification_received', details })
  await enqueue(db, ref, ctx.clock.now())
}

export async function notify(ctx: SyncContext, ref: RecordRef, details: object): Promise<void> {
  await ctx.db.transaction().execute((tx) => notifyIn(tx, ctx, ref, details))
}
