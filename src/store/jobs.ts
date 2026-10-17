// sync_jobs repository: a queue with one pending and at most one running job per record.
import { sql } from 'kysely'
import type { Kysely } from 'kysely'
import type { Database, EntityType, JobStatus, RecordRef, System } from '../db/database.js'

export interface Job {
  id: string
  system: System
  entityType: EntityType
  entityId: string
  attempts: number
  status: JobStatus
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
        ORDER BY j.run_after
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

export async function completeJob(db: Kysely<Database>, job: Job): Promise<void> {
  await db
    .updateTable('sync_jobs')
    .set({ status: 'done', lease_until: null })
    .where('id', '=', job.id)
    .execute()
}

export async function retryJob(
  db: Kysely<Database>,
  job: Job,
  runAfter: Date,
  error: string
): Promise<void> {
  try {
    await db
      .updateTable('sync_jobs')
      .set({ status: 'pending', run_after: runAfter, lease_until: null, last_error: error })
      .where('id', '=', job.id)
      .execute()
  } catch (e) {
    if ((e as { code?: string }).code !== UNIQUE_VIOLATION) throw e
    // A newer notification already queued a pending job for this record; it covers the retry.
    await db
      .updateTable('sync_jobs')
      .set({ status: 'done', lease_until: null, last_error: error })
      .where('id', '=', job.id)
      .execute()
  }
}

export async function failJob(db: Kysely<Database>, job: Job, error: string): Promise<void> {
  await db
    .updateTable('sync_jobs')
    .set({ status: 'failed', lease_until: null, last_error: error })
    .where('id', '=', job.id)
    .execute()
}
