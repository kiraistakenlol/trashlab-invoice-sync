// Initial reconciliation: queues a job for every record on both sides.
import { ENTITY_TYPES, type EntityType } from '../db/database.js'
import type { QboEntityName } from '../qbo/entities.js'
import { getCursor, setCursor } from '../store/cursors.js'
import type { SyncContext } from './context.js'
import { notify } from './intake.js'
import { pollQbo } from './poll.js'

const PAGE_SIZE = 100

const QBO_ENTITY: Record<EntityType, QboEntityName> = {
  account: 'Account',
  item: 'Item',
  customer: 'Customer',
  invoice: 'Invoice',
  payment: 'Payment',
}

// A cursor already stored stays where it is: moving it would skip or replay changes; a missing
// one is set to the end of the feed (invoicing) or to now (QBO), so only later changes are polled.
async function recordCursors(ctx: SyncContext): Promise<void> {
  if ((await getCursor(ctx.db, 'invoicing')) === null) {
    let last: string | null = null
    for (;;) {
      const events = await ctx.invoicing.listEvents(last, PAGE_SIZE)
      if (events.length === 0) break
      last = events[events.length - 1].id
    }
    if (last !== null) await setCursor(ctx.db, 'invoicing', last)
  }
  await pollQbo(ctx) // with no cursor stored it stores now and returns; otherwise it is a normal poll
}

async function invoicingIds(ctx: SyncContext): Promise<Record<EntityType, string[]>> {
  const ids = (rows: { id: string }[]) => rows.map((r) => r.id)
  return {
    account: ids(await ctx.invoicing.listAccounts()),
    item: ids(await ctx.invoicing.listItems()),
    customer: ids(await ctx.invoicing.listCustomers()),
    invoice: ids(await ctx.invoicing.listInvoices()),
    payment: ids(await ctx.invoicing.listPayments()),
  }
}

// Every QBO account is queued; the account rules ignore the ones that are not income accounts.
export async function enqueueAll(ctx: SyncContext): Promise<{ invoicing: number; qbo: number }> {
  await recordCursors(ctx)
  const counts = { invoicing: 0, qbo: 0 }
  const fromInvoicing = await invoicingIds(ctx)
  for (const entityType of ENTITY_TYPES) {
    for (const entityId of fromInvoicing[entityType]) {
      await notify(ctx, { system: 'invoicing', entityType, entityId }, { source: 'reconcile' })
      counts.invoicing++
    }
    for (const { Id } of await ctx.qbo.listAll(QBO_ENTITY[entityType])) {
      await notify(ctx, { system: 'qbo', entityType, entityId: Id }, { source: 'reconcile' })
      counts.qbo++
    }
  }
  ctx.log.info(counts, 'initial reconciliation queued')
  return counts
}
