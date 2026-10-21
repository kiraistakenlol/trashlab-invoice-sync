import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RecordRef } from '../../../src/db/database.js'
import { QboApiError } from '../../../src/qbo/api.js'
import { enqueue, type Job } from '../../../src/store/jobs.js'
import { DEFAULT_SYNC_CONFIG, type SyncContext } from '../../../src/sync/context.js'
import { createWorker } from '../../../src/sync/worker.js'
import pino from 'pino'
import { freshDb } from '../../harness/fresh-db.js'

let t: Awaited<ReturnType<typeof freshDb>>
let time: number
beforeEach(async () => {
  t = await freshDb()
  time = Date.parse('2026-01-05T10:00:00Z')
})
afterEach(() => t.destroy())

const advance = (ms: number) => {
  time += ms
}
const ref = (entityId: string): RecordRef => ({ system: 'qbo', entityType: 'invoice', entityId })
const now = () => new Date(time)

function setup(run: (job: Job) => Promise<void>, log = pino({ level: 'silent' })) {
  const ctx = {
    db: t.db,
    clock: { now },
    random: () => 0.5,
    config: { ...DEFAULT_SYNC_CONFIG, qboWebhookVerifierToken: '' },
    log,
  } as unknown as SyncContext
  return createWorker(ctx, run, { concurrency: 2 })
}
const jobs = () => t.db.selectFrom('sync_jobs').selectAll().execute()
const timeout = () => new DOMException('timed out', 'TimeoutError')

// a logger whose lines are collected as parsed JSON
function capture() {
  const lines: Record<string, unknown>[] = []
  const log = pino({ level: 'debug' }, { write: (line: string) => lines.push(JSON.parse(line)) })
  return { log, lines }
}

describe('worker', () => {
  it('completes a job whose run succeeds', async () => {
    await enqueue(t.db, ref('1'), now())
    const w = setup(async () => {})
    expect(await w.runOnce()).toBe(true)
    expect((await jobs())[0]).toMatchObject({ status: 'done', attempts: 1 })
    expect(await w.runOnce()).toBe(false)
  })

  it('retries a transient failure 0.5-1 s later, and only once due', async () => {
    let calls = 0
    const w = setup(async () => {
      if (++calls === 1) throw timeout()
    })
    await enqueue(t.db, ref('1'), now())
    expect(await w.drain()).toBe(1)
    const [row] = await jobs()
    expect(row).toMatchObject({ status: 'pending', last_error: 'timed out' })
    const delay = row!.run_after.getTime() - time
    expect(delay).toBeGreaterThanOrEqual(500)
    expect(delay).toBeLessThanOrEqual(1000)

    expect(await w.drain()).toBe(0)
    advance(1_000)
    expect(await w.drain()).toBe(1)
    expect((await jobs())[0]).toMatchObject({ status: 'done', attempts: 2 })
  })

  it('audits a failed attempt that will be retried', async () => {
    const w = setup(async () => {
      throw timeout()
    })
    await enqueue(t.db, ref('1'), now())
    await w.runOnce()
    const [job] = await jobs()
    const entries = await t.db.selectFrom('audit_log').selectAll().execute()
    expect(entries).toMatchObject([
      {
        entity_id: '1',
        job_id: job!.id,
        action: 'attempt_failed',
        error: 'timed out',
        details: {
          attempt: 1,
          failure: 'transient',
          next: 'retry',
          runAfter: job!.run_after.toISOString(),
        },
      },
    ])
  })

  it('audits the attempt that fails a job', async () => {
    const w = setup(async () => {
      throw new QboApiError(400, ['2020'], null, null, 'QBO 400 [2020]')
    })
    await enqueue(t.db, ref('1'), now())
    await w.runOnce()
    expect(await t.db.selectFrom('audit_log').selectAll().execute()).toMatchObject([
      {
        action: 'attempt_failed',
        error: 'QBO 400 [2020]',
        details: { attempt: 1, failure: 'permanent', next: 'failed' },
      },
    ])
  })

  it('honours retryAfterMs from a throttled call', async () => {
    const w = setup(async () => {
      throw new QboApiError(429, [], 1_000, 'tid', 'slow down')
    })
    await enqueue(t.db, ref('1'), now())
    await w.drain()
    const [row] = await jobs()
    expect(row!.run_after.getTime() - time).toBeGreaterThanOrEqual(1_000)
  })

  it('fails a permanent error with its message', async () => {
    const w = setup(async () => {
      throw new Error('bad payload')
    })
    await enqueue(t.db, ref('1'), now())
    await w.drain()
    expect((await jobs())[0]).toMatchObject({ status: 'failed', last_error: 'bad payload' })
  })

  it('fails the job on its 8th transient failure', async () => {
    const w = setup(async () => {
      throw timeout()
    })
    await enqueue(t.db, ref('1'), now())
    for (let i = 1; i <= 7; i++) {
      await w.drain()
      expect((await jobs())[0]).toMatchObject({ status: 'pending', attempts: i })
      advance(DEFAULT_SYNC_CONFIG.backoffMaxMs)
    }
    await w.drain()
    expect((await jobs())[0]).toMatchObject({ status: 'failed', attempts: 8 })
  })

  it('runs jobs for different records in one drain', async () => {
    const seen: string[] = []
    const w = setup(async (job) => void seen.push(job.entityId))
    await enqueue(t.db, ref('1'), now())
    await enqueue(t.db, ref('2'), now())
    expect(await w.drain()).toBe(2)
    expect(seen.sort()).toEqual(['1', '2'])
  })

  it('start polls for due jobs and stop waits for them', async () => {
    const seen: string[] = []
    const w = setup(async (job) => void seen.push(job.entityId))
    w.start(5)
    await enqueue(t.db, ref('1'), now())
    for (let i = 0; i < 200 && seen.length === 0; i++) await new Promise((r) => setTimeout(r, 10))
    await w.stop()
    expect(seen).toEqual(['1'])
    expect((await jobs())[0]!.status).toBe('done')
  })

  it('logs a failure with the record and the QBO trace id', async () => {
    const { log, lines } = capture()
    const w = setup(async () => {
      throw new QboApiError(400, ['2050'], null, 'tid-1', 'invalid')
    }, log)
    await enqueue(t.db, ref('7'), now())
    await w.drain()
    expect(lines.find((l) => l.msg === 'job failed')).toMatchObject({
      system: 'qbo',
      entity: 'invoice',
      entityId: '7',
      intuitTid: 'tid-1',
    })
  })
})
