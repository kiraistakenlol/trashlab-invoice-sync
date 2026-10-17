// The scenario-test world: both fakes, a database, the sync's HTTP server, one manual clock.
import type { Kysely } from 'kysely'
import pino from 'pino'
import type { EntityType, System } from '../../src/db/database.js'
import type { Database } from '../../src/db/database.js'
import { buildServer, type SyncServer } from '../../src/http/server.js'
import type { InvoicingClient } from '../../src/invoicing/client.js'
import type { InvoicingEvent } from '../../src/invoicing/types.js'
import { QboApi } from '../../src/qbo/api.js'
import type { QboClient, QboResponse, RequestOptions } from '../../src/qbo/client.js'
import { signQboWebhook, type QboWebhookEntity } from '../../src/qbo/webhooks.js'
import { auditHistory } from '../../src/store/audit.js'
import { listIssues } from '../../src/store/issues.js'
import { findLink } from '../../src/store/links.js'
import type { Job } from '../../src/store/jobs.js'
import { DEFAULT_SYNC_CONFIG, type SyncConfig, type SyncContext } from '../../src/sync/context.js'
import { reconcile } from '../../src/sync/engine.js'
import { createWorker } from '../../src/sync/worker.js'
import { FakeInvoicing } from '../fakes/fake-invoicing.js'
import { FakeQbo } from '../fakes/fake-qbo.js'
import { freshDb } from './fresh-db.js'
import { QboActor } from './qbo-actor.js'

const START = '2026-01-05T10:00:00Z'
const TEST_VERIFIER_TOKEN = 'test-verifier-token'
const TEST_REALM = '9130000000000000'

export interface ManualClock {
  now(): Date
  advance(ms: number): void
}

export interface DeliverOptions {
  duplicate?: boolean
  reverse?: boolean
  drop?: (e: QboWebhookEntity | InvoicingEvent) => boolean
}

export interface QboMatch {
  method: string
  path: string // prefix of the request path, without its query string
}

type Hook = () => Promise<void>

export interface World {
  clock: ManualClock
  db: Kysely<Database>
  invoicing: FakeInvoicing
  qbo: FakeQbo
  qboActor: QboActor
  ctx: SyncContext
  server: SyncServer
  hook(system: 'invoicing', match: keyof InvoicingClient, fn: Hook, when: 'before' | 'after'): void
  hook(system: 'qbo', match: QboMatch, fn: Hook, when: 'before' | 'after'): void
  run: (job: Job) => Promise<void>
  deliver(opts?: DeliverOptions): Promise<void>
  // posts the given notifications as the system's webhook would
  webhook(system: 'qbo', notifications: QboWebhookEntity[]): Promise<void>
  webhook(system: 'invoicing', notifications: InvoicingEvent[]): Promise<void>
  drain(): Promise<number>
  poll(): Promise<void>
  sync(): Promise<void>
  history(system: System, entityType: EntityType, id: string): ReturnType<typeof auditHistory>
  issues(): ReturnType<typeof listIssues>
  linkOf(entityType: EntityType, system: System, id: string): ReturnType<typeof findLink>
  close(): Promise<void>
}

interface PendingHook {
  system: System
  match: string | QboMatch
  fn: Hook
  when: 'before' | 'after'
}

export async function createWorld(opts: { config?: Partial<SyncConfig> } = {}): Promise<World> {
  let time = Date.parse(START)
  const clock: ManualClock = {
    now: () => new Date(time),
    advance: (ms) => {
      time += ms
    },
  }
  const now = () => clock.now()

  const invoicing = new FakeInvoicing({ now })
  const qbo = new FakeQbo({ now })
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
      if (typeof value !== 'function' || typeof prop !== 'string') return value
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
    if (res.statusCode !== 200) throw new Error(`POST ${url} -> ${res.statusCode} ${res.body}`)
  }

  async function webhook(
    system: System,
    notifications: (QboWebhookEntity | InvoicingEvent)[]
  ): Promise<void> {
    if (system === 'invoicing') {
      for (const event of notifications) await post('/webhooks/invoicing', JSON.stringify(event))
      return
    }
    const body = JSON.stringify({
      eventNotifications: [{ realmId: TEST_REALM, dataChangeEvent: { entities: notifications } }],
    })
    await post('/webhooks/qbo', body, {
      'intuit-signature': signQboWebhook(body, TEST_VERIFIER_TOKEN),
    })
  }

  // Posts every pending webhook of both fakes; returns how many notifications went out.
  async function deliverPending(o: DeliverOptions = {}): Promise<number> {
    const drop = o.drop
    const entities = qbo.takeWebhooks({ ...o, drop: drop && ((e) => drop(e)) })
    if (entities.length > 0) await webhook('qbo', entities)
    const events = invoicing.takeWebhooks({ ...o, drop: drop && ((e) => drop(e)) })
    if (events.length > 0) await webhook('invoicing', events)
    return entities.length + events.length
  }

  const worker = createWorker(ctx, (job) => world.run(job), { concurrency: 1 })

  const world: World = {
    clock,
    db,
    invoicing,
    qbo,
    qboActor: new QboActor(qbo),
    ctx,
    server,
    hook(system: System, match: string | QboMatch, fn: Hook, when: 'before' | 'after') {
      hooks.push({ system, match, fn, when })
    },
    run: (job) =>
      reconcile(
        ctx,
        { system: job.system, entityType: job.entityType, entityId: job.entityId },
        job.id
      ),
    async deliver(o) {
      await deliverPending(o)
    },
    webhook,
    drain: () => worker.drain(),
    async poll() {
      throw new Error('not implemented')
    },
    async sync() {
      // A drained job can write to the fakes and leave new notifications behind.
      let activity: number
      do {
        activity = (await deliverPending()) + (await world.drain())
      } while (activity > 0)
    },
    history: (system, entityType, entityId) => auditHistory(db, { system, entityType, entityId }),
    issues: () => listIssues(db),
    linkOf: (entityType, system, id) => findLink(db, entityType, system, id),
    async close() {
      await server.close()
      await destroy()
    },
  }
  return world
}
