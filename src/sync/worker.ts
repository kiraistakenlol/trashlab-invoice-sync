// Job worker: claims due jobs, runs them, and turns each outcome into a queue state.
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

  function settled(job: Job, applied: boolean): void {
    if (!applied)
      log.debug({ jobId: job.id, attempts: job.attempts }, 'job reclaimed, outcome dropped')
  }

  async function handleFailure(job: Job, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error)
    const failure = classify(error)
    if (failure.kind === 'permanent' || job.attempts >= config.maxAttempts) {
      log.error({ jobId: job.id, attempts: job.attempts, err: error }, 'job failed')
      settled(job, await failJob(db, job, message))
      return
    }
    const delay = Math.max(failure.retryAfterMs ?? 0, backoffMs(job.attempts))
    log.warn({ jobId: job.id, attempts: job.attempts, delayMs: delay, err: error }, 'job retry')
    settled(job, await retryJob(db, job, new Date(clock.now().getTime() + delay), message))
  }

  async function runOnce(): Promise<boolean> {
    const job = await claimJob(db, clock.now(), config.leaseMs)
    if (!job) return false
    try {
      await run(job)
    } catch (error) {
      await handleFailure(job, error)
      return true
    }
    settled(job, await completeJob(db, job))
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
