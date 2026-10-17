import { afterEach, beforeEach, expect, it } from 'vitest'
import { freshDb } from '../../harness/fresh-db.js'
import type { RecordRef } from '../../../src/db/database.js'
import { claimJob, completeJob, enqueue, failJob, retryJob } from '../../../src/store/jobs.js'

let t: Awaited<ReturnType<typeof freshDb>>
beforeEach(async () => {
  t = await freshDb()
})
afterEach(() => t.destroy())

const ref: RecordRef = { system: 'qbo', entityType: 'invoice', entityId: '1' }
const T0 = new Date('2026-01-01T00:00:00Z')
const at = (ms: number) => new Date(T0.getTime() + ms)
const rows = () => t.db.selectFrom('sync_jobs').selectAll().orderBy('created_at').execute()

it('merges repeated notifications into one pending job', async () => {
  await enqueue(t.db, ref, T0)
  await enqueue(t.db, ref, T0)
  expect(await rows()).toHaveLength(1)
})

it('claims a due job with a lease', async () => {
  await enqueue(t.db, ref, T0)
  const job = await claimJob(t.db, T0, 60_000)
  expect(job).toMatchObject({ ...ref, status: 'running', attempts: 1 })
  const [row] = await rows()
  expect(row!.lease_until).toEqual(at(60_000))
  expect(await claimJob(t.db, T0, 60_000)).toBeNull()
})

it('does not claim a job that is not yet due', async () => {
  await enqueue(t.db, ref, at(1000))
  expect(await claimJob(t.db, T0, 60_000)).toBeNull()
  expect(await claimJob(t.db, at(1000), 60_000)).not.toBeNull()
})

it('does not claim a pending job while its record is running under a live lease', async () => {
  await enqueue(t.db, ref, T0)
  await claimJob(t.db, T0, 60_000)
  await enqueue(t.db, ref, T0)
  expect(await rows()).toHaveLength(2)
  expect(await claimJob(t.db, at(1000), 60_000)).toBeNull()
})

it('claims a running job again once its lease expired', async () => {
  await enqueue(t.db, ref, T0)
  await claimJob(t.db, T0, 60_000)
  const again = await claimJob(t.db, at(60_000), 60_000)
  expect(again).toMatchObject({ status: 'running', attempts: 2 })
})

it('schedules a retry with the error', async () => {
  await enqueue(t.db, ref, T0)
  const job = (await claimJob(t.db, T0, 60_000))!
  await retryJob(t.db, job, at(5000), 'timeout')
  const [row] = await rows()
  expect(row).toMatchObject({ status: 'pending', last_error: 'timeout', run_after: at(5000) })
  expect(await claimJob(t.db, at(4000), 60_000)).toBeNull()
  expect(await claimJob(t.db, at(5000), 60_000)).toMatchObject({ attempts: 2 })
})

it('completes and fails jobs', async () => {
  await enqueue(t.db, ref, T0)
  await completeJob(t.db, (await claimJob(t.db, T0, 60_000))!)
  await enqueue(t.db, ref, T0)
  await failJob(t.db, (await claimJob(t.db, T0, 60_000))!, 'gave up')
  expect((await rows()).map((r) => [r.status, r.last_error])).toEqual([
    ['done', null],
    ['failed', 'gave up'],
  ])
})

it('treats a retry as covered when a newer pending job exists', async () => {
  await enqueue(t.db, ref, T0)
  const job = (await claimJob(t.db, T0, 60_000))!
  await enqueue(t.db, ref, T0)
  await retryJob(t.db, job, at(5000), 'timeout')
  expect((await rows()).map((r) => r.status)).toEqual(['done', 'pending'])
})

it('reclaims an expired running job before a pending job of the same record', async () => {
  await enqueue(t.db, ref, T0)
  const a = (await claimJob(t.db, T0, 60_000))!
  await enqueue(t.db, ref, at(-1000))
  const reclaimed = await claimJob(t.db, at(60_000), 60_000)
  expect(reclaimed).toMatchObject({ id: a.id, attempts: 2 })
  await completeJob(t.db, reclaimed!)
  expect(await claimJob(t.db, at(60_000), 60_000)).toMatchObject({ status: 'running', attempts: 1 })
})

it('ignores a late outcome from a job whose lease was reclaimed', async () => {
  await enqueue(t.db, ref, T0)
  const stale = (await claimJob(t.db, T0, 60_000))!
  await claimJob(t.db, at(60_000), 60_000)
  await completeJob(t.db, stale)
  await retryJob(t.db, stale, at(70_000), 'timeout')
  await failJob(t.db, stale, 'gave up')
  const [row] = await rows()
  expect(row).toMatchObject({ status: 'running', attempts: 2, last_error: null })
  expect(row!.lease_until).toEqual(at(120_000))
})

it('ignores a late retry whose record already has a pending job', async () => {
  await enqueue(t.db, ref, T0)
  const stale = (await claimJob(t.db, T0, 60_000))!
  await claimJob(t.db, at(60_000), 60_000)
  await enqueue(t.db, ref, at(60_000))
  await retryJob(t.db, stale, at(70_000), 'timeout')
  expect((await rows()).map((r) => [r.status, r.attempts])).toEqual([
    ['running', 2],
    ['pending', 0],
  ])
})
