// Kysely table types mirroring the database schema.
import type { ColumnType, Generated } from 'kysely'

export type System = 'invoicing' | 'qbo'
export type EntityType = 'account' | 'item' | 'customer' | 'invoice' | 'payment'
export type JobStatus = 'pending' | 'running' | 'done' | 'failed'
export type IssueKind =
  | 'conflict'
  | 'unsupported'
  | 'revived_void'
  | 'number_changed'
  | 'number_taken'
  | 'ambiguous_match'
  | 'taxed_lines_edited'
export type IssueResolution = 'invoicing' | 'qbo' | 'converged'
export type AuditAction =
  | 'notification_received'
  | 'linked'
  | 'created'
  | 'updated'
  | 'voided'
  | 'deleted'
  | 'no_change'
  | 'issue_opened'
  | 'issue_resolved'
  | 'retry_scheduled'
  | 'failed'
export type AuditOutcome = 'succeeded' | 'failed' | 'skipped'

// A timestamp column with a default: optional on insert, plain Date on read.
type Timestamp = Generated<Date>
type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>

export interface InvoicingQboLinksTable {
  id: Generated<string>
  entity_type: EntityType
  invoicing_id: string | null
  qbo_id: string | null
  create_idempotency_key: Generated<string>
  snapshot: unknown
  invoicing_version: number | null
  qbo_sync_token: string | null
  version: Generated<number>
  deleted_at: NullableTimestamp
  created_at: Timestamp
  updated_at: Timestamp
}

export interface SyncJobsTable {
  id: Generated<string>
  system: System
  entity_type: string
  entity_id: string
  status: Generated<JobStatus>
  attempts: Generated<number>
  run_after: Timestamp
  lease_until: NullableTimestamp
  last_error: string | null
  created_at: Timestamp
  updated_at: Timestamp
}

export interface SyncIssuesTable {
  id: Generated<string>
  system: System
  entity_type: string
  entity_id: string
  link_id: string | null
  kind: IssueKind
  details: unknown
  resolved_at: NullableTimestamp
  resolution: IssueResolution | null
  created_at: Timestamp
  updated_at: Timestamp
}

export interface AuditLogTable {
  id: Generated<string>
  system: System
  entity_type: string
  entity_id: string
  link_id: string | null
  job_id: string | null
  action: AuditAction
  changes: unknown
  outcome: AuditOutcome
  error: string | null
  details: unknown
  created_at: Timestamp
}

export interface PollCursorsTable {
  system: System
  cursor: string
  updated_at: Timestamp
}

export interface Database {
  invoicing_qbo_links: InvoicingQboLinksTable
  sync_jobs: SyncJobsTable
  sync_issues: SyncIssuesTable
  audit_log: AuditLogTable
  poll_cursors: PollCursorsTable
}
