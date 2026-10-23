// What every scenario world shares: database, sync context, HTTP server, worker, call hooks.
import type { Kysely } from 'kysely'
import pino from 'pino'
import type { Database, EntityType, System } from '../../src/db/database.js'
import { buildServer, type SyncServer } from '../../src/http/server.js'
import type { InvoicingClient } from '../../src/invoicing/client.js'
import type { InvoicingEvent } from '../../src/invoicing/types.js'
import { QboApi } from '../../src/qbo/api.js'
import type { QboClient, QboResponse, RequestOptions } from '../../src/qbo/client.js'
import { signQboWebhook, type QboWebhookEntity } from '../../src/qbo/webhooks.js'
import { auditHistory } from '../../src/store/audit.js'
import { listIssues } from '../../src/store/issues.js'
import type { Job } from '../../src/store/jobs.js'
import { findLink } from '../../src/store/links.js'
import { DEFAULT_SYNC_CONFIG, type SyncConfig, type SyncContext } from '../../src/sync/context.js'
import { reconcile } from '../../src/sync/engine.js'
import { pollInvoicing, pollQbo } from '../../src/sync/poll.js'
import { createWorker } from '../../src/sync/worker.js'
import type { InMemoryInvoicing } from '../../invoicing-sim/invoicing.js'
import { freshDb } from './fresh-db.js'

const TEST_VERIFIER_TOKEN = 'test-verifier-token'
const TEST_REALM = '9130000000000000'

export interface DeliverOptions {
  duplicate?: boolean
  reverse?: boolean
  drop?: (e: QboWebhookEntity | InvoicingEvent) => boolean
}

export interface QboMatch {
  method: string
  path: string // prefix of the request path, without its query string
}

type HookFn = () => Promise<void>

export interface Hook {
  (system: 'invoicing', match: keyof InvoicingClient, fn: HookFn, when: 'before' | 'after'): void
  (system: 'qbo', match: QboMatch, fn: HookFn, when: 'before' | 'after'): void
}

export interface WorldCore {
  db: Kysely<Database>
  ctx: SyncContext
  server: SyncServer
  hook: Hook
  run: (job: Job) => Promise<void>
  // posts the given notifications as the system's webhook would
  webhook(system: 'qbo', notifications: QboWebhookEntity[]): Promise<void>
  webhook(system: 'invoicing', notifications: InvoicingEvent[]): Promise<void>
  // posts the invoicing fake's pending webhooks; returns how many went out
  deliverInvoicing(opts?: DeliverOptions): Promise<number>
  drain(): Promise<number>
  poll(): Promise<void>
  history(system: System, entityType: EntityType, id: string): ReturnType<typeof auditHistory>
  issues(): ReturnType<typeof listIssues>
  linkOf(entityType: EntityType, system: System, id: string): ReturnType<typeof findLink>
  close(): Promise<void>
}

interface PendingHook {
  system: System
  match: string | QboMatch
  fn: HookFn
  when: 'before' | 'after'
}

export async function createWorldCore(opts: {
  qbo: QboClient
  invoicing: InMemoryInvoicing
  now: () => Date
  config?: Partial<SyncConfig>
}): Promise<WorldCore> {
  const { qbo, invoicing, now } = opts
  const { db, destroy } = await freshDb()

  const hooks: PendingHook[] = []
  // Runs and removes the first registered hook that matches, one-shot.
  const around = async <T>(
    system: System,
    matches: (m: PendingHook['match']) => boolean,
    call: () => Promise<T>
  ): Promise<T> => {
    const take = (when: 'before' | 'after') => {
      const i = hooks.findIndex((h) => h.system === system && h.when === when && matches(h.match))
      return i < 0 ? undefined : hooks.splice(i, 1)[0]
    }
    await take('before')?.fn()
    const result = await call()
    await take('after')?.fn()
    return result
  }

  const qboWrapper: QboClient = {
    request(method: string, path: string, o?: RequestOptions): Promise<QboResponse> {
      const pathname = new URL(path, 'http://fake').pathname
      return around(
        'qbo',
        (m) =>
          typeof m !== 'string' &&
          m.method.toUpperCase() === method.toUpperCase() &&
          pathname.startsWith(m.path),
        () => qbo.request(method, path, o)
      )
    },
    query: (sql) => qboWrapper.request('GET', '/query', { query: { query: sql } }),
  }

  const invoicingWrapper = new Proxy(invoicing, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof value !== 'function' || typeof prop !== 'string') {
        return value
      }
      return (...args: unknown[]) =>
        around(
          'invoicing',
          (m) => m === prop,
          () => value.apply(target, args)
        )
    },
  }) as InvoicingClient

  const ctx: SyncContext = {
    db,
    invoicing: invoicingWrapper,
    qbo: new QboApi(qboWrapper),
    clock: { now },
    random: () => 0.5,
    config: {
      ...DEFAULT_SYNC_CONFIG,
      qboWebhookVerifierToken: TEST_VERIFIER_TOKEN,
      ...opts.config,
    },
    log: pino({ level: 'silent' }),
  }
  const server = buildServer(ctx)

  async function post(url: string, payload: string, headers: Record<string, string> = {}) {
    const res = await server.inject({
      method: 'POST',
      url,
      payload,
      headers: { 'content-type': 'application/json', ...headers },
    })
    if (res.statusCode !== 200) {
      throw new Error(`POST ${url} -> ${res.statusCode} ${res.body}`)
    }
  }

  async function webhook(
    system: System,
    notifications: (QboWebhookEntity | InvoicingEvent)[]
  ): Promise<void> {
    if (system === 'invoicing') {
      for (const event of notifications) {
        await post('/webhooks/invoicing', JSON.stringify(event))
      }
      return
    }
    const body = JSON.stringify({
      eventNotifications: [{ realmId: TEST_REALM, dataChangeEvent: { entities: notifications } }],
    })
    await post('/webhooks/qbo', body, {
      'intuit-signature': signQboWebhook(body, TEST_VERIFIER_TOKEN),
    })
  }

  const worker = createWorker(ctx, (job) => core.run(job), { concurrency: 1 })

  const core: WorldCore = {
    db,
    ctx,
    server,
    hook(system: System, match: string | QboMatch, fn: HookFn, when: 'before' | 'after') {
      hooks.push({ system, match, fn, when })
    },
    run: (job) =>
      reconcile(
        ctx,
        { system: job.system, entityType: job.entityType, entityId: job.entityId },
        job.id
      ),
    webhook,
    async deliverInvoicing(o = {}) {
      const drop = o.drop
      const events = invoicing.takeWebhooks({ ...o, drop: drop && ((e) => drop(e)) })
      if (events.length > 0) {
        await webhook('invoicing', events)
      }
      return events.length
    },
    drain: () => worker.drain(),
    async poll() {
      await pollInvoicing(ctx)
      await pollQbo(ctx)
    },
    history: (system, entityType, entityId) => auditHistory(db, { system, entityType, entityId }),
    issues: () => listIssues(db),
    linkOf: (entityType, system, id) => findLink(db, entityType, system, id),
    async close() {
      await server.close()
      await destroy()
    },
  }
  return core
}
