// Job worker: claims due jobs, runs them, and turns each outcome into a queue state.
import type { Logger } from 'pino'
import { QboApiError } from '../qbo/api.js'
import { audit } from '../store/audit.js'
import { claimJob, completeJob, failJob, retryJob, type Job } from '../store/jobs.js'
import { errorMessage } from '../error-message.js'
import type { SyncContext } from './context.js'
import { classify, type Failure } from './errors.js'

export interface Worker {
  runOnce(): Promise<boolean>
  drain(): Promise<number>
  start(pollMs: number): void
  stop(): Promise<void>
}

function backoffMs(ctx: SyncContext, attempts: number): number {
  const { backoffBaseMs, backoffMaxMs } = ctx.config
  const exponential = Math.min(backoffMaxMs, backoffBaseMs * 2 ** (attempts - 1))
  return exponential * (0.5 + ctx.random() / 2)
}

// an outcome applies only to the claim that still owns the job
function logIfReclaimed(jobLog: Logger, applied: boolean): void {
  if (!applied) {
    jobLog.debug('job reclaimed, outcome dropped')
  }
}

async function auditFailedAttempt(
  ctx: SyncContext,
  job: Job,
  failure: Failure,
  error: unknown,
  next: object
): Promise<void> {
  await audit(ctx.db, {
    ref: { system: job.system, entityType: job.entityType, entityId: job.entityId },
    jobId: job.id,
    action: 'attempt_failed',
    error: errorMessage(error),
    details: { attempt: job.attempts, failure: failure.kind, ...next },
  })
}

async function failForGood(
  ctx: SyncContext,
  job: Job,
  jobLog: Logger,
  failure: Failure,
  error: unknown
): Promise<void> {
  jobLog.error({ err: error }, 'job failed')
  const applied = await failJob(ctx.db, job, errorMessage(error))
  logIfReclaimed(jobLog, applied)
  if (applied) {
    await auditFailedAttempt(ctx, job, failure, error, { next: 'failed' })
  }
}

async function scheduleRetry(
  ctx: SyncContext,
  job: Job,
  jobLog: Logger,
  failure: Failure,
  error: unknown
): Promise<void> {
  const delay = Math.max(failure.retryAfterMs ?? 0, backoffMs(ctx, job.attempts))
  const runAfter = new Date(ctx.clock.now().getTime() + delay)
  // a stale read is ordinary concurrency: the job reruns from fresh reads
  if (failure.kind === 'stale') {
    jobLog.info(
      { delayMs: delay, reason: errorMessage(error) },
      'job rerun: record changed meanwhile'
    )
  } else {
    jobLog.warn({ delayMs: delay, err: error }, 'job retry')
  }
  const applied = await retryJob(ctx.db, job, runAfter, errorMessage(error))
  logIfReclaimed(jobLog, applied)
  if (applied) {
    const next = { next: 'retry', runAfter: runAfter.toISOString() }
    await auditFailedAttempt(ctx, job, failure, error, next)
  }
}

async function handleFailure(
  ctx: SyncContext,
  job: Job,
  jobLog: Logger,
  error: unknown
): Promise<void> {
  const failure = classify(error)
  const intuitTid = error instanceof QboApiError ? error.intuitTid : undefined
  const errLog = intuitTid ? jobLog.child({ intuitTid }) : jobLog
  if (failure.kind === 'permanent' || job.attempts >= ctx.config.maxAttempts) {
    return failForGood(ctx, job, errLog, failure, error)
  }
  return scheduleRetry(ctx, job, errLog, failure, error)
}

async function runOnce(ctx: SyncContext, run: (job: Job) => Promise<void>): Promise<boolean> {
  const job = await claimJob(ctx.db, ctx.clock.now(), ctx.config.leaseMs)
  if (!job) {
    return false
  }
  const { id: jobId, system, entityType, entityId, attempts } = job
  const jobLog = ctx.log.child({ jobId, system, entity: entityType, entityId, attempts })
  try {
    await run(job)
  } catch (error) {
    await handleFailure(ctx, job, jobLog, error)
    return true
  }
  logIfReclaimed(jobLog, await completeJob(ctx.db, job))
  return true
}

async function loop(
  ctx: SyncContext,
  run: (job: Job) => Promise<void>,
  pollMs: number,
  isRunning: () => boolean
): Promise<void> {
  while (isRunning()) {
    let found = false
    try {
      found = await runOnce(ctx, run)
    } catch (err) {
      ctx.log.error({ err }, 'worker loop error')
    }
    if (!found && isRunning()) {
      await new Promise((resolve) => setTimeout(resolve, pollMs))
    }
  }
}

export function createWorker(
  ctx: SyncContext,
  run: (job: Job) => Promise<void>,
  opts: { concurrency: number }
): Worker {
  let running = false
  let loops: Promise<void>[] = []
  const isRunning = () => running

  return {
    runOnce: () => runOnce(ctx, run),
    async drain() {
      let ran = 0
      while (await runOnce(ctx, run)) {
        ran++
      }
      return ran
    },
    start(pollMs) {
      if (running) {
        return
      }
      running = true
      loops = Array.from({ length: opts.concurrency }, () => loop(ctx, run, pollMs, isRunning))
    },
    async stop() {
      running = false
      await Promise.all(loops)
      loops = []
    },
  }
}
