// The scenario-test world: both fakes, a database, the sync's HTTP server, one manual clock.
import type { Kysely } from 'kysely'
import type { Database } from '../../src/db/database.js'
import type { SyncServer } from '../../src/http/server.js'
import type { InvoicingEvent } from '../../src/invoicing/types.js'
import type { QboWebhookEntity } from '../../src/qbo/webhooks.js'
import type { Job } from '../../src/store/jobs.js'
import type { SyncConfig, SyncContext } from '../../src/sync/context.js'
import { InMemoryInvoicing } from '../../invoicing-sim/invoicing.js'
import { FakeQbo } from '../fakes/fake-qbo.js'
import { QboActor } from './qbo-actor.js'
import { createWorldCore, type DeliverOptions, type Hook, type WorldCore } from './world-core.js'

const START = '2026-01-05T10:00:00Z'

export interface ScenarioClock {
  now(): Date
  advance(ms: number): Promise<void>
}

// What a scenario sees, whether QBO is the fake or the sandbox.
export interface ScenarioWorld {
  clock: ScenarioClock
  db: Kysely<Database>
  invoicing: InMemoryInvoicing
  qboActor: QboActor
  ctx: SyncContext
  named(base: string): string // a record name unique to the world
  hook: Hook
  deliver(opts?: DeliverOptions): Promise<void>
  webhook(system: 'invoicing', notifications: InvoicingEvent[]): Promise<void>
  // delivers notifications and runs jobs until nothing new turns up
  sync(): Promise<void>
  // syncs until ready() holds; fails naming `what` when it never does
  syncUntil(ready: () => Promise<boolean>, what: string): Promise<void>
  history: WorldCore['history']
  issues: WorldCore['issues']
  linkOf: WorldCore['linkOf']
  close(): Promise<void>
}

export interface World extends ScenarioWorld {
  qbo: FakeQbo
  server: SyncServer
  run: (job: Job) => Promise<void>
  webhook(system: 'qbo', notifications: QboWebhookEntity[]): Promise<void>
  webhook(system: 'invoicing', notifications: InvoicingEvent[]): Promise<void>
  drain(): Promise<number>
  poll(): Promise<void>
}

export async function createWorld(opts: { config?: Partial<SyncConfig> } = {}): Promise<World> {
  let time = Date.parse(START)
  const clock: ScenarioClock = {
    now: () => new Date(time),
    advance: async (ms) => {
      time += ms
    },
  }
  const now = () => clock.now()

  const invoicing = new InMemoryInvoicing({ now })
  const qbo = new FakeQbo({ now })
  const core = await createWorldCore({ qbo, invoicing, now, config: opts.config })

  // Posts every pending webhook of both fakes; returns how many notifications went out.
  async function deliverPending(o: DeliverOptions = {}): Promise<number> {
    const drop = o.drop
    const entities = qbo.takeWebhooks({ ...o, drop: drop && ((e) => drop(e)) })
    if (entities.length > 0) {
      await core.webhook('qbo', entities)
    }
    return entities.length + (await core.deliverInvoicing(o))
  }

  const world: World = Object.assign(core, {
    clock,
    invoicing,
    qbo,
    qboActor: new QboActor(qbo),
    named: (base: string) => base,
    async deliver(o?: DeliverOptions) {
      await deliverPending(o)
    },
    async sync() {
      // A drained job can write to the fakes and leave new notifications behind.
      let activity: number
      do {
        activity = (await deliverPending()) + (await core.drain())
      } while (activity > 0)
    },
    async syncUntil(ready: () => Promise<boolean>, what: string) {
      await world.sync()
      if (!(await ready())) {
        throw new Error(`not ready after sync: ${what}`)
      }
    },
  })
  await world.poll() // records the cursors
  return world
}
