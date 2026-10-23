// invoicing_qbo_links repository: which invoicing record is which QBO record.
import { sql, type Kysely, type Selectable } from 'kysely'
import type { Database, EntityType, InvoicingQboLinksTable, System } from '../db/database.js'
import { isUniqueViolation } from '../db/pg-errors.js'

export interface Link {
  id: string
  entityType: EntityType
  invoicingId: string | null
  qboId: string | null
  createIdempotencyKey: string
  snapshot: unknown | null
  invoicingVersion: number | null
  qboSyncToken: string | null
  version: number
  deletedAt: Date | null
}

export type LinkPatch = Partial<
  Pick<
    Link,
    'invoicingId' | 'qboId' | 'snapshot' | 'invoicingVersion' | 'qboSyncToken' | 'deletedAt'
  >
>

const PATCH_COLUMNS = {
  invoicingId: 'invoicing_id',
  qboId: 'qbo_id',
  snapshot: 'snapshot',
  invoicingVersion: 'invoicing_version',
  qboSyncToken: 'qbo_sync_token',
  deletedAt: 'deleted_at',
} as const satisfies Record<keyof LinkPatch, keyof InvoicingQboLinksTable>

export const sideId = (link: Link, system: System): string | null =>
  system === 'invoicing' ? link.invoicingId : link.qboId

export function setSideId(patch: LinkPatch, system: System, id: string): void {
  if (system === 'invoicing') {
    patch.invoicingId = id
  } else {
    patch.qboId = id
  }
}

// a version is the invoicing version number or the QBO SyncToken
export function storedVersion(link: Link, system: System): string | null {
  if (system === 'qbo') {
    return link.qboSyncToken
  }
  return link.invoicingVersion === null ? null : String(link.invoicingVersion)
}

export function setVersion(patch: LinkPatch, system: System, version: string | null): void {
  if (system === 'qbo') {
    patch.qboSyncToken = version
  } else {
    patch.invoicingVersion = version === null ? null : Number.parseInt(version, 10)
  }
}

function toLink(row: Selectable<InvoicingQboLinksTable>): Link {
  return {
    id: row.id,
    entityType: row.entity_type,
    invoicingId: row.invoicing_id,
    qboId: row.qbo_id,
    createIdempotencyKey: row.create_idempotency_key,
    snapshot: row.snapshot ?? null,
    invoicingVersion: row.invoicing_version,
    qboSyncToken: row.qbo_sync_token,
    version: row.version,
    deletedAt: row.deleted_at,
  }
}

export async function findLink(
  db: Kysely<Database>,
  entityType: EntityType,
  system: System,
  id: string
): Promise<Link | null> {
  const row = await db
    .selectFrom('invoicing_qbo_links')
    .selectAll()
    .where('entity_type', '=', entityType)
    .where(system === 'invoicing' ? 'invoicing_id' : 'qbo_id', '=', id)
    .executeTakeFirst()
  return row ? toLink(row) : null
}

export async function getLink(db: Kysely<Database>, id: string): Promise<Link> {
  const row = await db
    .selectFrom('invoicing_qbo_links')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow()
  return toLink(row)
}

// Links holding only the other side's id and the fields of a create in progress.
export async function pendingLinks(
  db: Kysely<Database>,
  entityType: EntityType,
  missing: System
): Promise<Link[]> {
  const rows = await db
    .selectFrom('invoicing_qbo_links')
    .selectAll()
    .where('entity_type', '=', entityType)
    .where(missing === 'invoicing' ? 'invoicing_id' : 'qbo_id', 'is', null)
    .where('deleted_at', 'is', null)
    .where('snapshot', 'is not', null)
    .execute()
  return rows.map(toLink)
}

// Live payment links, linked in QBO, whose snapshot allocates to the invoice link.
export async function paymentLinksAllocating(
  db: Kysely<Database>,
  invoiceLinkId: string
): Promise<Link[]> {
  const rows = await db
    .selectFrom('invoicing_qbo_links')
    .selectAll()
    .where('entity_type', '=', 'payment')
    .where('qbo_id', 'is not', null)
    .where('deleted_at', 'is', null)
    .where(
      sql<boolean>`snapshot -> 'allocations' @> ${JSON.stringify([{ invoice: invoiceLinkId }])}::jsonb`
    )
    .execute()
  return rows.map(toLink)
}

export async function insertLink(
  db: Kysely<Database>,
  entityType: EntityType,
  ids: { invoicingId?: string | null; qboId?: string | null }
): Promise<Link | null> {
  try {
    const row = await db
      .insertInto('invoicing_qbo_links')
      .values({
        entity_type: entityType,
        invoicing_id: ids.invoicingId ?? null,
        qbo_id: ids.qboId ?? null,
        invoicing_version: null,
        qbo_sync_token: null,
        snapshot: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    return toLink(row)
  } catch (e) {
    if (isUniqueViolation(e)) {
      return null
    }
    throw e
  }
}

export async function updateLink(
  db: Kysely<Database>,
  link: Link,
  patch: LinkPatch
): Promise<Link | null> {
  const set: Record<string, unknown> = { version: link.version + 1 }
  for (const [field, column] of Object.entries(PATCH_COLUMNS)) {
    if (field in patch) {
      set[column] = patch[field as keyof LinkPatch]
    }
  }
  if ('snapshot' in patch) {
    set.snapshot = patch.snapshot == null ? null : JSON.stringify(patch.snapshot)
  }
  try {
    const row = await db
      .updateTable('invoicing_qbo_links')
      .set(set)
      .where('id', '=', link.id)
      .where('version', '=', link.version)
      .returningAll()
      .executeTakeFirst()
    return row ? toLink(row) : null
  } catch (e) {
    if (isUniqueViolation(e)) {
      return null
    }
    throw e
  }
}
