// The runnable sync service: context, HTTP server, job worker and the poll loop.
import type { Logger } from 'pino'
import { systemClock } from './clock.js'
import type { ServiceConfig } from './config.js'
import { createDb } from './db/create-db.js'
import { buildServer } from './http/server.js'
import { createInvoicingClient } from './invoicing/http-client.js'
import { createQboClient, fileTokenStore, QboApi } from './qbo/index.js'
import { DEFAULT_SYNC_CONFIG, type SyncContext } from './sync/context.js'
import { reconcile } from './sync/engine.js'
import { pollInvoicing, pollQbo } from './sync/poll.js'
import { createWorker } from './sync/worker.js'

export interface Service {
  ctx: SyncContext
  start(): Promise<void>
  stop(): Promise<void>
}

export function createContext(config: ServiceConfig, log: Logger): SyncContext {
  const qbo = createQboClient({
    oauth: config.qbo.oauth,
    environment: config.qbo.environment,
    tokenStore: fileTokenStore(config.qbo.connectionFile),
  })
  return {
    db: createDb(config.databaseUrl),
    invoicing: createInvoicingClient(config.invoicing),
    qbo: new QboApi(qbo),
    clock: systemClock,
    random: Math.random,
    config: { ...DEFAULT_SYNC_CONFIG, qboWebhookVerifierToken: config.qbo.webhookVerifierToken },
    log,
  }
}

// Polls both systems every `intervalMs`, one cycle at a time; a failing side is logged and
// tried again next cycle.
function createPollLoop(ctx: SyncContext, intervalMs: number) {
  let timer: NodeJS.Timeout | undefined
  let cycle: Promise<void> = Promise.resolve()
  let running = false

  async function pollOnce(): Promise<void> {
    const sides = [
      ['invoicing', pollInvoicing],
      ['qbo', pollQbo],
    ] as const
    for (const [system, poll] of sides) {
      try {
        const enqueued = await poll(ctx)
        if (enqueued > 0) {
          ctx.log.info({ system, enqueued }, 'poll picked up changes')
        }
      } catch (err) {
        ctx.log.error({ system, err }, 'poll failed')
      }
    }
  }

  function schedule(delayMs: number): void {
    timer = setTimeout(() => {
      cycle = pollOnce().then(() => {
        if (running) {
          schedule(intervalMs)
        }
      })
    }, delayMs)
  }

  return {
    start() {
      running = true
      schedule(0)
    },
    async stop() {
      running = false
      clearTimeout(timer)
      await cycle
    },
  }
}

export function createService(config: ServiceConfig, log: Logger): Service {
  const ctx = createContext(config, log)
  const server = buildServer(ctx)
  const worker = createWorker(
    ctx,
    (job) =>
      reconcile(
        ctx,
        { system: job.system, entityType: job.entityType, entityId: job.entityId },
        job.id
      ),
    { concurrency: config.workerConcurrency }
  )
  const poller = createPollLoop(ctx, config.pollIntervalMs)

  return {
    ctx,
    async start() {
      await server.listen({ port: config.port })
      worker.start(config.workerIdleMs)
      poller.start()
      log.info(
        { port: config.port, qboEnvironment: config.qbo.environment },
        'sync service started'
      )
    },
    async stop() {
      await Promise.all([poller.stop(), worker.stop()])
      await server.close()
      await ctx.db.destroy()
      log.info('sync service stopped')
    },
  }
}
