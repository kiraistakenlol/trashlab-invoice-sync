// Job worker: claims due jobs, runs them, and turns each outcome into a queue state.
import type { Logger } from 'pino'
import { QboApiError } from '../qbo/api.js'
import { audit } from '../store/audit.js'
import { claimJob, completeJob, failJob, retryJob, type Job } from '../store/jobs.js'
import type { SyncContext } from './context.js'
import { classify } from './errors.js'

export interface Worker {
  runOnce(): Promise<boolean>
  drain(): Promise<number>
  start(pollMs: number): void
  stop(): Promise<void>
}

export function createWorker(
  ctx: SyncContext,
  run: (job: Job) => Promise<void>,
  opts: { concurrency: number }
): Worker {
  const { db, clock, config, log } = ctx

  function backoffMs(attempts: number): number {
    const exponential = Math.min(config.backoffMaxMs, config.backoffBaseMs * 2 ** (attempts - 1))
    return exponential * (0.5 + ctx.random() / 2)
  }

  function settled(jobLog: Logger, applied: boolean): void {
    if (!applied) jobLog.debug('job reclaimed, outcome dropped')
  }

  async function handleFailure(job: Job, jobLog: Logger, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error)
    const failure = classify(error)
    const intuitTid = error instanceof QboApiError ? error.intuitTid : undefined
    const errLog = intuitTid ? jobLog.child({ intuitTid }) : jobLog
    // the attempt is audited only by the claim that still owns the job
    const record = async (applied: boolean, next: object) => {
      settled(jobLog, applied)
      if (!applied) return
      await audit(db, {
        ref: { system: job.system, entityType: job.entityType, entityId: job.entityId },
        jobId: job.id,
        action: 'attempt_failed',
        error: message,
        details: { attempt: job.attempts, failure: failure.kind, ...next },
      })
    }
    if (failure.kind === 'permanent' || job.attempts >= config.maxAttempts) {
      errLog.error({ err: error }, 'job failed')
      await record(await failJob(db, job, message), { next: 'failed' })
      return
    }
    const delay = Math.max(failure.retryAfterMs ?? 0, backoffMs(job.attempts))
    const runAfter = new Date(clock.now().getTime() + delay)
    errLog.warn({ delayMs: delay, err: error }, 'job retry')
    await record(await retryJob(db, job, runAfter, message), {
      next: 'retry',
      runAfter: runAfter.toISOString(),
    })
  }

  async function runOnce(): Promise<boolean> {
    const job = await claimJob(db, clock.now(), config.leaseMs)
    if (!job) return false
    const { id: jobId, system, entityType, entityId, attempts } = job
    const jobLog = log.child({ jobId, system, entityType, entityId, attempts })
    try {
      await run(job)
    } catch (error) {
      await handleFailure(job, jobLog, error)
      return true
    }
    settled(jobLog, await completeJob(db, job))
    return true
  }

  async function drain(): Promise<number> {
    let ran = 0
    while (await runOnce()) ran++
    return ran
  }

  let running = false
  let loops: Promise<void>[] = []

  function start(pollMs: number): void {
    if (running) return
    running = true
    const loop = async () => {
      while (running) {
        let found = false
        try {
          found = await runOnce()
        } catch (err) {
          log.error({ err }, 'worker loop error')
        }
        if (!found && running) await new Promise((resolve) => setTimeout(resolve, pollMs))
      }
    }
    loops = Array.from({ length: opts.concurrency }, loop)
  }

  async function stop(): Promise<void> {
    running = false
    await Promise.all(loops)
    loops = []
  }

  return { runOnce, drain, start, stop }
}
