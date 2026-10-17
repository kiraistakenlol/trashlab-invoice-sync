// audit_log repository: append-only record of what the sync saw and did.
import type { Kysely } from 'kysely'
import type { AuditAction, Database, RecordRef, System } from '../db/database.js'

export type FieldChanges = Record<string, { from: unknown; to: unknown; source: System }>

export interface AuditEntry {
  ref: RecordRef
  jobId?: string
  action: AuditAction
  changes?: FieldChanges
  details?: object
  error?: string
}

export interface AuditRow {
  id: string
  ref: RecordRef
  jobId: string | null
  action: AuditAction
  changes: FieldChanges | null
  details: object | null
  error: string | null
  createdAt: Date
}

const json = (value: object | undefined) => (value === undefined ? null : JSON.stringify(value))

export async function audit(db: Kysely<Database>, entry: AuditEntry): Promise<void> {
  await db
    .insertInto('audit_log')
    .values({
      system: entry.ref.system,
      entity_type: entry.ref.entityType,
      entity_id: entry.ref.entityId,
      job_id: entry.jobId ?? null,
      action: entry.action,
      changes: json(entry.changes),
      details: json(entry.details),
      error: entry.error ?? null,
    })
    .execute()
}

export async function auditHistory(db: Kysely<Database>, ref: RecordRef): Promise<AuditRow[]> {
  const rows = await db
    .selectFrom('audit_log')
    .selectAll()
    .where('system', '=', ref.system)
    .where('entity_type', '=', ref.entityType)
    .where('entity_id', '=', ref.entityId)
    .orderBy('id')
    .execute()
  return rows.map((r) => ({
    id: r.id,
    ref,
    jobId: r.job_id,
    action: r.action,
    changes: r.changes as FieldChanges | null,
    details: r.details as object | null,
    error: r.error,
    createdAt: r.created_at,
  }))
}
