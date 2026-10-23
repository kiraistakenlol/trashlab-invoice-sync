// The scenario world on the real QBO sandbox: system clock, QBO changes only through CDC,
// names unique to the world, and its QBO records removed on close.
import { randomBytes } from 'node:crypto'
import { errorMessage } from '../../src/error-message.js'
import { QboApi } from '../../src/qbo/api.js'
import { QBO_ENTITY_NAMES, type QboEntityName } from '../../src/qbo/entities.js'
import type { SyncConfig } from '../../src/sync/context.js'
import { pollQbo } from '../../src/sync/poll.js'
import { InMemoryInvoicing } from '../../invoicing-sim/invoicing.js'
import { eventually } from './eventually.js'
import { QboActor } from './qbo-actor.js'
import { sandboxClient } from './sandbox.js'
import type { ScenarioClock, ScenarioWorld } from './world.js'
import { createWorldCore } from './world-core.js'

const SANDBOX_SETTLE_MS = 90_000
const SETTLE_INTERVAL_MS = 2_000
const MAX_SYNC_ROUNDS = 20
const SANDBOX_CONFIG: Partial<SyncConfig> = { backoffBaseMs: 200, cdcStepBackMs: 5_000 }

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export async function createSandboxWorld(
  opts: { config?: Partial<SyncConfig> } = {}
): Promise<ScenarioWorld> {
  const prefix = 's' + randomBytes(3).toString('hex').slice(0, 5)
  const clock: ScenarioClock = { now: () => new Date(), advance: sleep }
  const qbo = sandboxClient()
  const invoicing = new InMemoryInvoicing({ numberPrefix: `${prefix}-` })
  const core = await createWorldCore({
    qbo,
    invoicing,
    now: clock.now,
    config: { ...SANDBOX_CONFIG, ...opts.config },
  })
  const qboActor = new QboActor(qbo)
  const api = new QboApi(qbo)

  // the audit entries after `afterId` that record something the sync did
  const lastAuditId = async () =>
    Number(
      (
        await core.db
          .selectFrom('audit_log')
          .select((eb) => eb.fn.max('id').as('id'))
          .executeTakeFirstOrThrow()
      ).id ?? 0
    )
  const effectsSince = (afterId: number) =>
    core.db
      .selectFrom('audit_log')
      .select(['system', 'entity_type', 'entity_id', 'action', 'error'])
      .where('id', '>', String(afterId))
      .where('action', 'not in', ['notification_received', 'no_change'])
      .orderBy('id')
      .execute()

  // Deletes the world's payments and invoices and deactivates its catalogue records. A
  // linked record counts as the world's only when its name (or its customer's) carries the
  // prefix, so records of others that the sync picked up stay untouched.
  async function cleanup(): Promise<string[]> {
    const ids = new Map<QboEntityName, Set<string>>(QBO_ENTITY_NAMES.map((e) => [e, new Set()]))
    const links = await core.db
      .selectFrom('invoicing_qbo_links')
      .select(['entity_type', 'qbo_id'])
      .where('qbo_id', 'is not', null)
      .execute()
    for (const { entity_type, qbo_id } of links) {
      ids.get(QBO_ENTITY_NAMES.find((e) => e.toLowerCase() === entity_type)!)!.add(qbo_id!)
    }
    const created = new Set(qboActor.created().map((c) => `${c.entity}:${c.id}`))
    for (const { entity, id } of qboActor.created()) {
      ids.get(entity)!.add(id)
    }
    const mine = (entity: QboEntityName, id: string, name: string) =>
      created.has(`${entity}:${id}`) || name.startsWith(`${prefix} `)

    const failures: string[] = []
    const attempt = async (entity: QboEntityName, id: string, run: () => Promise<void>) => {
      try {
        await run()
      } catch (e) {
        failures.push(`${entity} ${id}: ${errorMessage(e)}`)
      }
    }

    const customers = new Set<string>()
    for (const id of ids.get('Customer')!) {
      await attempt('Customer', id, async () => {
        const c = await api.get('Customer', id)
        if (c && mine('Customer', id, c.DisplayName)) {
          customers.add(id)
        }
      })
    }
    for (const entity of ['Payment', 'Invoice'] as const) {
      for (const id of ids.get(entity)!) {
        await attempt(entity, id, async () => {
          const record = await api.get(entity, id)
          if (!record) {
            return
          }
          if (!created.has(`${entity}:${id}`) && !customers.has(record.CustomerRef.value)) {
            return
          }
          await api.remove(entity, id, record.SyncToken)
        })
      }
    }
    for (const entity of ['Customer', 'Item', 'Account'] as const) {
      for (const id of ids.get(entity)!) {
        await attempt(entity, id, async () => {
          const record = await api.get(entity, id)
          if (!record?.Active) {
            return
          }
          const name = 'DisplayName' in record ? record.DisplayName : record.Name
          if (!mine(entity, id, name)) {
            return
          }
          await api.update(entity, { Id: id, SyncToken: record.SyncToken, Active: false })
        })
      }
    }
    return failures
  }

  const world: ScenarioWorld = {
    clock,
    db: core.db,
    invoicing,
    qboActor,
    ctx: core.ctx,
    named: (base) => `${prefix} ${base}`,
    hook: core.hook,
    async deliver(o) {
      await core.deliverInvoicing(o)
    },
    webhook: (system, events) => core.webhook(system, events),
    async sync() {
      // CDC windows overlap and the sandbox has a record dated in the future, so QBO always
      // reports something: the run is quiet once a round delivers nothing and changes nothing.
      // One that never quiets fails, naming what its last round did.
      for (let round = 1; ; round++) {
        const before = await lastAuditId()
        const delivered = await core.deliverInvoicing()
        await core.drain()
        await pollQbo(core.ctx)
        await core.drain()
        const effects = await effectsSince(before)
        if (delivered === 0 && effects.length === 0) {
          return
        }
        if (round === MAX_SYNC_ROUNDS) {
          const last = effects.map(
            (e) =>
              `${e.action} ${e.system} ${e.entity_type} ${e.entity_id}` +
              (e.error === null ? '' : ` (${e.error})`)
          )
          throw new Error(
            `sync still active after ${MAX_SYNC_ROUNDS} rounds; the last delivered ` +
              `${delivered} invoicing events and audited:\n${last.join('\n')}`
          )
        }
      }
    },
    async syncUntil(ready, what) {
      try {
        await eventually(
          async () => {
            await world.sync()
            return ready()
          },
          (ok) => ok,
          { timeoutMs: SANDBOX_SETTLE_MS, intervalMs: SETTLE_INTERVAL_MS }
        )
      } catch (e) {
        throw new Error(`${what}: ${errorMessage(e)}`, { cause: e })
      }
    },
    history: core.history,
    issues: core.issues,
    linkOf: core.linkOf,
    async close() {
      let failures: string[]
      try {
        failures = await cleanup()
      } finally {
        await core.close()
      }
      if (failures.length > 0) {
        throw new Error(`cleanup failed:\n${failures.join('\n')}`)
      }
    },
  }
  await core.poll() // records the cursors
  return world
}
