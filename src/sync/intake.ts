// Turns a change notification into a queued job and an audit entry, atomically.
import type { RecordRef } from '../db/database.js'
import { audit } from '../store/audit.js'
import { enqueue } from '../store/jobs.js'
import type { SyncContext } from './context.js'

export async function notify(ctx: SyncContext, ref: RecordRef, details: object): Promise<void> {
  await ctx.db.transaction().execute(async (tx) => {
    await audit(tx, { ref, action: 'notification_received', details })
    await enqueue(tx, ref, ctx.clock.now())
  })
}
