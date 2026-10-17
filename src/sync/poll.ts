// Polls the invoicing events feed and QBO's change data capture from stored cursors.
import type { QboEntityName } from '../qbo/entities.js'
import { getCursor, setCursor } from '../store/cursors.js'
import type { SyncContext } from './context.js'
import { entityTypeOfQbo, notifyIn } from './intake.js'

const PAGE_SIZE = 100
const QBO_ENTITIES: QboEntityName[] = ['Account', 'Item', 'Customer', 'Invoice', 'Payment']

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

export async function pollQbo(ctx: SyncContext): Promise<number> {
  const cursor = await getCursor(ctx.db, 'qbo')
  if (cursor === null) {
    await setCursor(ctx.db, 'qbo', ctx.clock.now().toISOString())
    return 0
  }
  const since = new Date(Date.parse(cursor) - ctx.config.cdcStepBackMs).toISOString()
  const changes = await ctx.qbo.changes(QBO_ENTITIES, since)
  let latest = new Date(cursor)
  let count = 0
  await ctx.db.transaction().execute(async (tx) => {
    for (const { entity, id, deleted, updated } of changes) {
      const entityType = entityTypeOfQbo(entity)
      if (!entityType) continue
      await notifyIn(
        tx,
        ctx,
        { system: 'qbo', entityType, entityId: id },
        { source: 'cdc', deleted }
      )
      count++
      if (updated !== null && new Date(updated) > latest) latest = new Date(updated)
    }
    await setCursor(tx, 'qbo', latest.toISOString())
  })
  return count
}
