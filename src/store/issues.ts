// sync_issues repository: what the sync flagged instead of deciding.
import type { Kysely, Selectable } from 'kysely'
import type {
  Database,
  EntityType,
  IssueKind,
  IssueResolution,
  RecordRef,
  SyncIssuesTable,
} from '../db/database.js'

export interface Issue {
  id: string
  ref: RecordRef
  linkId: string | null
  kind: IssueKind
  details: Record<string, unknown>
  resolvedAt: Date | null
  resolution: IssueResolution | null
}

function toIssue(row: Selectable<SyncIssuesTable>): Issue {
  return {
    id: row.id,
    ref: { system: row.system, entityType: row.entity_type as EntityType, entityId: row.entity_id },
    linkId: row.link_id,
    kind: row.kind,
    details: row.details,
    resolvedAt: row.resolved_at,
    resolution: row.resolution,
  }
}

export async function openIssue(
  db: Kysely<Database>,
  input: {
    ref: RecordRef
    linkId: string | null
    kind: IssueKind
    details: Record<string, unknown>
  }
): Promise<Issue> {
  const details = JSON.stringify(input.details)
  const insert = db.insertInto('sync_issues').values({
    system: input.ref.system,
    entity_type: input.ref.entityType,
    entity_id: input.ref.entityId,
    link_id: input.linkId,
    kind: input.kind,
    details,
    resolution: null,
  })
  const row = await (
    input.linkId
      ? insert.onConflict((oc) =>
          oc
            .columns(['link_id', 'kind'])
            .where('resolved_at', 'is', null)
            .where('link_id', 'is not', null)
            .doUpdateSet({ details })
        )
      : insert.onConflict((oc) =>
          oc
            .columns(['system', 'entity_type', 'entity_id', 'kind'])
            .where('resolved_at', 'is', null)
            .where('link_id', 'is', null)
            .doUpdateSet({ details })
        )
  )
    .returningAll()
    .executeTakeFirstOrThrow()
  return toIssue(row)
}

// Rewrites an issue's details while it is still open; a resolved one is left as it is.
export async function updateIssueDetails(
  db: Kysely<Database>,
  id: string,
  details: Record<string, unknown>
): Promise<void> {
  await db
    .updateTable('sync_issues')
    .set({ details: JSON.stringify(details) })
    .where('id', '=', id)
    .where('resolved_at', 'is', null)
    .execute()
}

export async function openIssues(
  db: Kysely<Database>,
  by: { linkId: string } | { ref: RecordRef }
): Promise<Issue[]> {
  let q = db.selectFrom('sync_issues').selectAll().where('resolved_at', 'is', null)
  q =
    'linkId' in by
      ? q.where('link_id', '=', by.linkId)
      : q
          .where('system', '=', by.ref.system)
          .where('entity_type', '=', by.ref.entityType)
          .where('entity_id', '=', by.ref.entityId)
  return (await q.orderBy('created_at').execute()).map(toIssue)
}

export async function getIssue(db: Kysely<Database>, id: string): Promise<Issue | null> {
  const row = await db.selectFrom('sync_issues').selectAll().where('id', '=', id).executeTakeFirst()
  return row ? toIssue(row) : null
}

export async function listIssues(
  db: Kysely<Database>,
  opts: { open?: boolean } = {}
): Promise<Issue[]> {
  let q = db.selectFrom('sync_issues').selectAll()
  if (opts.open) q = q.where('resolved_at', 'is', null)
  return (await q.orderBy('created_at').orderBy('id').execute()).map(toIssue)
}

export async function resolveIssue(
  db: Kysely<Database>,
  id: string,
  resolution: IssueResolution,
  at: Date
): Promise<void> {
  await db
    .updateTable('sync_issues')
    .set({ resolved_at: at, resolution })
    .where('id', '=', id)
    .execute()
}
