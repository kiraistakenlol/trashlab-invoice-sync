// Lookups between link ids and side ids for the mappers; links dependencies on demand.
import type { EntityType, System } from '../db/database.js'
import { findLink, getLink, type Link } from '../store/links.js'
import type { SyncContext } from './context.js'
import { reconcile } from './engine.js'
import { BlockedError } from './errors.js'
import type { ToLink, ToSide } from './neutral.js'

export interface SideRef {
  entityType: EntityType
  id: string
}

const linked = (link: Link | null): link is Link =>
  link !== null && link.invoicingId !== null && link.qboId !== null && link.deletedAt === null

// The id of the active link holding this record on both sides; the record is reconciled
// once when it has none.
export async function ensureLinked(
  ctx: SyncContext,
  system: System,
  entityType: EntityType,
  id: string
): Promise<string> {
  const link = await findLink(ctx.db, entityType, system, id)
  if (linked(link)) return link.id
  await reconcile(ctx, { system, entityType, entityId: id }, ctx.jobId)
  const after = await findLink(ctx.db, entityType, system, id)
  if (!linked(after)) throw new BlockedError(`${system} ${entityType} ${id}`)
  return after.id
}

export async function toLinkFn(ctx: SyncContext, system: System, refs: SideRef[]): Promise<ToLink> {
  const ids = new Map<string, string>()
  for (const ref of refs) {
    ids.set(`${ref.entityType}:${ref.id}`, await ensureLinked(ctx, system, ref.entityType, ref.id))
  }
  return (entityType, id) => {
    const linkId = ids.get(`${entityType}:${id}`)
    if (linkId === undefined) throw new Error(`${system} ${entityType} ${id} was not resolved`)
    return linkId
  }
}

export async function toSideFn(
  ctx: SyncContext,
  system: System,
  linkIds: string[]
): Promise<ToSide> {
  const ids = new Map<string, string>()
  for (const linkId of new Set(linkIds)) {
    const link = await getLink(ctx.db, linkId)
    const id = system === 'invoicing' ? link.invoicingId : link.qboId
    if (id === null) throw new BlockedError(`link ${linkId} has no ${system} id`)
    ids.set(linkId, id)
  }
  return (linkId) => {
    const id = ids.get(linkId)
    if (id === undefined) throw new Error(`link ${linkId} was not resolved`)
    return id
  }
}
