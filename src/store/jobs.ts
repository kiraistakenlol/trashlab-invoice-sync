// sync_jobs repository: a queue with one pending and at most one running job per record.
import { sql } from 'kysely'
import type { Kysely, Selectable } from 'kysely'
import type {
  Database,
  EntityType,
  JobStatus,
  RecordRef,
  SyncJobsTable,
  System,
} from '../db/database.js'

export interface Job {
  id: string
  system: System
  entityType: EntityType
  entityId: string
  attempts: number
  status: JobStatus
}

export interface JobDetails extends Job {
  lastError: string | null
  runAfter: Date
  updatedAt: Date
}

const UNIQUE_VIOLATION = '23505'

export async function enqueue(db: Kysely<Database>, ref: RecordRef, runAfter: Date): Promise<void> {
  await db
    .insertInto('sync_jobs')
    .values({
      system: ref.system,
      entity_type: ref.entityType,
      entity_id: ref.entityId,
      run_after: runAfter,
      last_error: null,
    })
    .onConflict((oc) =>
      oc.columns(['system', 'entity_type', 'entity_id']).where('status', '=', 'pending').doNothing()
    )
    .execute()
}

export async function claimJob(
  db: Kysely<Database>,
  now: Date,
  leaseMs: number
): Promise<Job | null> {
  const leaseUntil = new Date(now.getTime() + leaseMs)
  try {
    const { rows } = await sql<{
      id: string
      system: System
      entity_type: EntityType
      entity_id: string
      attempts: number
      status: JobStatus
    }>`
      UPDATE sync_jobs
      SET status = 'running', attempts = attempts + 1, lease_until = ${leaseUntil}
      WHERE id = (
        SELECT j.id FROM sync_jobs j
        WHERE (j.status = 'pending' AND j.run_after <= ${now}
               AND NOT EXISTS (
                 SELECT 1 FROM sync_jobs r
                 WHERE r.status = 'running'
                   AND r.system = j.system AND r.entity_type = j.entity_type
                   AND r.entity_id = j.entity_id))
           OR (j.status = 'running' AND j.lease_until <= ${now})
        ORDER BY j.run_after, j.created_at, j.id
        LIMIT 1
        FOR UPDATE SKIP LOCKED)
      RETURNING id, system, entity_type, entity_id, attempts, status`.execute(db)
    const row = rows[0]
    if (!row) return null
    return {
      id: row.id,
      system: row.system,
      entityType: row.entity_type,
      entityId: row.entity_id,
      attempts: row.attempts,
      status: row.status,
    }
  } catch (e) {
    if ((e as { code?: string }).code === UNIQUE_VIOLATION) return null
    throw e
  }
}

// Outcomes apply only to the claim that produced them; a job reclaimed after its lease
// expired belongs to the new claim. Each returns whether it applied.
function owned(db: Kysely<Database>, job: Job) {
  return db
    .updateTable('sync_jobs')
    .where('id', '=', job.id)
    .where('status', '=', 'running')
    .where('attempts', '=', job.attempts)
}

const applied = (result: { numUpdatedRows: bigint }) => result.numUpdatedRows > 0n

export async function completeJob(db: Kysely<Database>, job: Job): Promise<boolean> {
  return applied(
    await owned(db, job).set({ status: 'done', lease_until: null }).executeTakeFirstOrThrow()
  )
}

export async function retryJob(
  db: Kysely<Database>,
  job: Job,
  runAfter: Date,
  error: string
): Promise<boolean> {
  try {
    return applied(
      await owned(db, job)
        .set({ status: 'pending', run_after: runAfter, lease_until: null, last_error: error })
        .executeTakeFirstOrThrow()
    )
  } catch (e) {
    if ((e as { code?: string }).code !== UNIQUE_VIOLATION) throw e
    // A newer notification already queued a pending job for this record; it covers the retry.
    return applied(
      await owned(db, job)
        .set({ status: 'done', lease_until: null, last_error: error })
        .executeTakeFirstOrThrow()
    )
  }
}

export async function failJob(db: Kysely<Database>, job: Job, error: string): Promise<boolean> {
  return applied(
    await owned(db, job)
      .set({ status: 'failed', lease_until: null, last_error: error })
      .executeTakeFirstOrThrow()
  )
}

function toDetails(r: Selectable<SyncJobsTable>): JobDetails {
  return {
    id: r.id,
    system: r.system,
    entityType: r.entity_type as EntityType,
    entityId: r.entity_id,
    status: r.status,
    attempts: r.attempts,
    lastError: r.last_error,
    runAfter: r.run_after,
    updatedAt: r.updated_at,
  }
}

export type RequeueOutcome = 'requeued' | 'not_failed' | 'already_pending' | 'not_found'

export async function requeueJob(
  db: Kysely<Database>,
  id: string,
  now: Date
): Promise<RequeueOutcome> {
  try {
    const result = await db
      .updateTable('sync_jobs')
      .where('id', '=', id)
      .where('status', '=', 'failed')
      .set({ status: 'pending', attempts: 0, run_after: now, lease_until: null })
      .executeTakeFirstOrThrow()
    if (result.numUpdatedRows > 0n) return 'requeued'
  } catch (e) {
    // The one-pending-job-per-record index rejects it: a newer notification already queued one.
    if ((e as { code?: string }).code === UNIQUE_VIOLATION) return 'already_pending'
    throw e
  }
  const row = await db.selectFrom('sync_jobs').select('id').where('id', '=', id).executeTakeFirst()
  return row ? 'not_failed' : 'not_found'
}

export async function getJob(db: Kysely<Database>, id: string): Promise<JobDetails> {
  const r = await db
    .selectFrom('sync_jobs')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow()
  return toDetails(r)
}

export async function listJobs(
  db: Kysely<Database>,
  opts: { status?: JobStatus } = {}
): Promise<JobDetails[]> {
  let q = db.selectFrom('sync_jobs').selectAll()
  if (opts.status) q = q.where('status', '=', opts.status)
  const rows = await q.orderBy('created_at').orderBy('id').execute()
  return rows.map(toDetails)
}
