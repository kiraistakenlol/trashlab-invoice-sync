// Polls the invoicing events feed and QBO's change data capture from stored cursors.
import { QBO_ENTITY_NAMES } from '../qbo/entities.js'
import { getCursor, setCursor } from '../store/cursors.js'
import type { SyncContext } from './context.js'
import { entityTypeOfQbo, notifyIn } from './intake.js'

const PAGE_SIZE = 100

export async function pollInvoicing(ctx: SyncContext): Promise<number> {
  let cursor = await getCursor(ctx.db, 'invoicing')
  let total = 0
  for (;;) {
    const events = await ctx.invoicing.listEvents(cursor, PAGE_SIZE)
    if (events.length === 0) return total
    const last = events[events.length - 1].id
    await ctx.db.transaction().execute(async (tx) => {
      for (const { entityType, entityId, kind, version } of events) {
        await notifyIn(
          tx,
          ctx,
          { system: 'invoicing', entityType, entityId },
          { source: 'feed', kind, version }
        )
      }
      await setCursor(tx, 'invoicing', last)
    })
    cursor = last
    total += events.length
  }
}

// The cursor is the time of the request, never a record's timestamp (the sandbox has records
// dated in the future). The next window starts `cdcStepBackMs` earlier, which covers clock skew
// and the exclusive whole-second `changedSince`. A capped entity holds the cursor back to the
// last update it returned, so the rest is read next time.
export async function pollQbo(ctx: SyncContext): Promise<number> {
  const stored = await getCursor(ctx.db, 'qbo')
  if (stored === null) {
    await setCursor(ctx.db, 'qbo', ctx.clock.now().toISOString())
    return 0
  }
  const requestedAt = ctx.clock.now()
  const since = new Date(Date.parse(stored) - ctx.config.cdcStepBackMs).toISOString()
  const { changes, capped } = await ctx.qbo.changes(QBO_ENTITY_NAMES, since)
  const reached = capped.map((c) => (c.lastUpdated ? new Date(c.lastUpdated) : new Date(stored)))
  const next = new Date(
    Math.max(Date.parse(stored), Math.min(requestedAt.getTime(), ...reached.map(Number)))
  )
  let count = 0
  await ctx.db.transaction().execute(async (tx) => {
    for (const { entity, id, deleted } of changes) {
      const entityType = entityTypeOfQbo(entity)
      if (!entityType) continue
      await notifyIn(
        tx,
        ctx,
        { system: 'qbo', entityType, entityId: id },
        { source: 'cdc', deleted }
      )
      count++
    }
    await setCursor(tx, 'qbo', next.toISOString())
  })
  return count
}
