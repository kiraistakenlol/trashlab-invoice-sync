// invoicing_qbo_links repository: which invoicing record is which QBO record.
import { sql, type Kysely, type Selectable } from 'kysely'
import type { Database, EntityType, InvoicingQboLinksTable, System } from '../db/database.js'

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

type LinkPatch = Partial<
  Pick<
    Link,
    'invoicingId' | 'qboId' | 'snapshot' | 'invoicingVersion' | 'qboSyncToken' | 'deletedAt'
  >
>

const UNIQUE_VIOLATION = '23505'

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
  ids: { invoicingId?: string; qboId?: string }
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
    if ((e as { code?: string }).code === UNIQUE_VIOLATION) {
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
  if ('invoicingId' in patch) {
    set.invoicing_id = patch.invoicingId
  }
  if ('qboId' in patch) {
    set.qbo_id = patch.qboId
  }
  if ('snapshot' in patch) {
    set.snapshot = patch.snapshot == null ? null : JSON.stringify(patch.snapshot)
  }
  if ('invoicingVersion' in patch) {
    set.invoicing_version = patch.invoicingVersion
  }
  if ('qboSyncToken' in patch) {
    set.qbo_sync_token = patch.qboSyncToken
  }
  if ('deletedAt' in patch) {
    set.deleted_at = patch.deletedAt
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
    if ((e as { code?: string }).code === UNIQUE_VIOLATION) {
      return null
    }
    throw e
  }
}
