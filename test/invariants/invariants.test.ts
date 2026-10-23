// Property-based sync invariants (SCENARIOS.md I1-I3): random edits on both sides, lossy
// delivery, failing calls.
import fc from 'fast-check'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { describe, expect, it } from 'vitest'
import { ENTITY_TYPES, type EntityType, type System } from '../../src/db/database.js'
import { InvoicingApiError } from '../../src/invoicing/errors.js'
import type { InvoicingClient } from '../../src/invoicing/client.js'
import type { InvoicingEvent } from '../../src/invoicing/types.js'
import type { Money } from '../../src/money.js'
import { QboApiError } from '../../src/qbo/api.js'
import type { QboEntityName } from '../../src/qbo/entities.js'
import type { QboWebhookEntity } from '../../src/qbo/webhooks.js'
import { specFor } from '../../src/sync/specs/index.js'
import type { Failure } from '../fakes/failures.js'
import type { QboFailure } from '../fakes/fake-qbo.js'
import { createWorld, type World } from '../harness/world.js'
import {
  DUE_DATE,
  editInvoice,
  linkedCustomer,
  linkedInvoice,
  linkedItem,
  qboLine,
} from '../scenarios/given.js'

const NUM_RUNS = 50
const PROPERTY_TIMEOUT_MS = 600_000 // a rare generated case runs far longer than the rest
const STEP_MS = 1_000
const SETTLE_MS = 10 * 60_000 // beyond the longest backoff
const MAX_SETTLE_PASSES = 20

const QBO_NAME: Record<EntityType, QboEntityName> = {
  account: 'Account',
  item: 'Item',
  customer: 'Customer',
  invoice: 'Invoice',
  payment: 'Payment',
}
const WRITES = ['created', 'updated', 'voided', 'deleted'] as const

// Model

type Delivery = 'normal' | 'duplicate' | 'reverse' | 'drop'
type InvoicingWrite = Extract<
  keyof InvoicingClient,
  'replaceInvoice' | 'voidInvoice' | 'deleteInvoice' | 'createPayment' | 'replacePayment'
>
type Armed =
  | {
      system: 'qbo'
      failure: Extract<QboFailure, 'timeout_after_write' | 'unavailable' | 'http_500'>
    }
  | {
      system: 'invoicing'
      op: InvoicingWrite
      failure: Extract<Failure, 'timeout_after_write' | 'unavailable'>
    }

type Command =
  | { kind: 'memo'; side: System; invoice: number; memo: string }
  | { kind: 'dueDate'; side: System; invoice: number; dueDate: string }
  | { kind: 'lines'; side: System; invoice: number; lines: number }
  | { kind: 'void' | 'delete'; side: System; invoice: number }
  | { kind: 'pay'; side: System; invoice: number; amount: Money }
  | { kind: 'editPayment'; side: System; payment: number; amount: Money }

interface Step {
  command: Command
  delivery: Delivery
  armed: Armed | null
}

const MEMOS = ['Gate code 1234', 'Call ahead']
const DUE_DATES = [DUE_DATE, '2026-03-01', '2026-03-15']
const AMOUNTS: Money[] = ['10.00', '25.00', '40.00']
// [item index, quantity, unit price, amount]
const LINE_SETS: [number, string, Money, Money][][] = [
  [[0, '2', '50.00', '100.00']],
  [
    [0, '1', '50.00', '50.00'],
    [1, '1', '30.00', '30.00'],
  ],
  [[1, '3', '30.00', '90.00']],
]

const side = fc.constantFrom<System>('invoicing', 'qbo')
const invoice = fc.integer({ min: 0, max: 2 })
const command: fc.Arbitrary<Command> = fc.oneof(
  fc.record({ kind: fc.constant('memo' as const), side, invoice, memo: fc.constantFrom(...MEMOS) }),
  fc.record({
    kind: fc.constant('dueDate' as const),
    side,
    invoice,
    dueDate: fc.constantFrom(...DUE_DATES),
  }),
  fc.record({
    kind: fc.constant('lines' as const),
    side,
    invoice,
    lines: fc.integer({ min: 0, max: LINE_SETS.length - 1 }),
  }),
  fc.record({ kind: fc.constantFrom('void' as const, 'delete' as const), side, invoice }),
  fc.record({
    kind: fc.constant('pay' as const),
    side,
    invoice,
    amount: fc.constantFrom(...AMOUNTS),
  }),
  fc.record({
    kind: fc.constant('editPayment' as const),
    side,
    payment: fc.nat({ max: 15 }),
    amount: fc.constantFrom(...AMOUNTS),
  })
)
const armed: fc.Arbitrary<Armed> = fc.oneof(
  fc.record({
    system: fc.constant('qbo' as const),
    failure: fc.constantFrom(
      'timeout_after_write' as const,
      'unavailable' as const,
      'http_500' as const
    ),
  }),
  fc.record({
    system: fc.constant('invoicing' as const),
    op: fc.constantFrom<InvoicingWrite>(
      'replaceInvoice',
      'voidInvoice',
      'deleteInvoice',
      'createPayment',
      'replacePayment'
    ),
    failure: fc.constantFrom('timeout_after_write' as const, 'unavailable' as const),
  })
)
const steps = fc.array(
  fc.record({
    command,
    delivery: fc.constantFrom<Delivery>('normal', 'duplicate', 'reverse', 'drop'),
    armed: fc.option(armed, { nil: null }),
  }),
  { minLength: 1, maxLength: 15 }
)

// Running a generated sequence

interface Simulation {
  w: World
  baselineQbo: Set<string> // `${entity}:${id}` of records the fake QBO starts with
  delivered: { qbo: QboWebhookEntity[]; invoicing: InvoicingEvent[] } // after the setup
  applied: number
}

function shaped<T>(xs: T[], delivery: Delivery): T[] {
  switch (delivery) {
    case 'drop':
      return []
    case 'duplicate':
      return xs.flatMap((x) => [x, structuredClone(x)])
    case 'reverse':
      return [...xs].reverse()
    default:
      return xs
  }
}

// Posts both fakes' pending notifications, shaped by `delivery`; returns how many were pending.
async function deliver(sim: Simulation, delivery: Delivery): Promise<number> {
  const qbo = sim.w.qbo.takeWebhooks()
  const invoicing = sim.w.invoicing.takeWebhooks()
  sim.delivered.qbo.push(...qbo)
  sim.delivered.invoicing.push(...invoicing)
  const qboOut = shaped(qbo, delivery)
  if (qboOut.length > 0) {
    await sim.w.webhook('qbo', qboOut)
  }
  const invoicingOut = shaped(invoicing, delivery)
  if (invoicingOut.length > 0) {
    await sim.w.webhook('invoicing', invoicingOut)
  }
  return qbo.length + invoicing.length
}

async function deliverAndDrain(sim: Simulation, delivery: Delivery): Promise<void> {
  let activity: number
  do {
    activity = (await deliver(sim, delivery)) + (await sim.w.drain())
  } while (activity > 0)
}

// The sync's next call of the kind fails once, through the fakes' own failure controls.
function arm(w: World, a: Armed): void {
  if (a.system === 'qbo') {
    w.hook(
      'qbo',
      { method: 'POST', path: '/' },
      async () => w.qbo.failNext({}, a.failure),
      'before'
    )
  } else {
    w.hook('invoicing', a.op, async () => w.invoicing.failNext(a.op, a.failure), 'before')
  }
}

interface Pair {
  invoicingId: string
  qboId: string
}

// The id of a record on `system`, through its link when it was made on the other side.
async function idOn(w: World, entityType: EntityType, made: System, id: string, system: System) {
  if (made === system) {
    return id
  }
  const link = await w.linkOf(entityType, made, id)
  return (system === 'invoicing' ? link?.invoicingId : link?.qboId) ?? null
}

// A person's change in one system; false when the system refuses it or it doesn't apply.
async function perform(
  w: World,
  c: Command,
  invoices: Pair[],
  items: string[],
  payments: { system: System; id: string }[]
): Promise<boolean> {
  try {
    if (c.kind === 'editPayment') {
      return await editPayment(w, c, payments)
    }
    const pair = invoices[c.invoice]!
    if (c.side === 'invoicing') {
      const current = await w.invoicing.getInvoice(pair.invoicingId)
      if (!current || current.deletedAt || current.voidedAt) {
        return false
      }
      switch (c.kind) {
        case 'memo':
          await editInvoice(w, current.id, { memo: c.memo })
          break
        case 'dueDate':
          await editInvoice(w, current.id, { dueDate: c.dueDate })
          break
        case 'lines':
          await editInvoice(w, current.id, {
            lines: LINE_SETS[c.lines]!.map(([item, quantity, unitPrice, amount]) => ({
              itemId: items[item]!,
              quantity,
              unitPrice,
              amount,
            })),
          })
          break
        case 'void':
          await w.invoicing.voidInvoice(current.id, current.version)
          break
        case 'delete':
          await w.invoicing.deleteInvoice(current.id, current.version)
          break
        case 'pay': {
          const payment = await w.invoicing.createPayment(
            {
              customerId: current.customerId,
              amount: c.amount,
              date: current.issueDate,
              allocations: [{ invoiceId: current.id, amount: c.amount }],
            },
            randomUUID()
          )
          payments.push({ system: 'invoicing', id: payment.id })
        }
      }
      return true
    }
    const current = await w.qboActor.get('Invoice', pair.qboId)
    if (!current) {
      return false
    }
    switch (c.kind) {
      case 'memo':
        await w.qboActor.updateInvoice(current.Id, { CustomerMemo: { value: c.memo } })
        break
      case 'dueDate':
        await w.qboActor.updateInvoice(current.Id, { DueDate: c.dueDate })
        break
      case 'lines':
        await w.qboActor.updateInvoice(current.Id, {
          Line: LINE_SETS[c.lines]!.map(([item, quantity, unitPrice, amount]) =>
            qboLine(items[item + 2]!, Number(quantity), Number(unitPrice), Number(amount))
          ),
        })
        break
      case 'void':
        await w.qboActor.voidInvoice(current.Id)
        break
      case 'delete':
        await w.qboActor.deleteInvoice(current.Id)
        break
      case 'pay': {
        const payment = await w.qboActor.createPayment(current.CustomerRef.value, c.amount, [
          { invoiceId: current.Id, amount: c.amount },
        ])
        payments.push({ system: 'qbo', id: payment.Id })
      }
    }
    return true
  } catch (error) {
    if (error instanceof InvoicingApiError || error instanceof QboApiError) {
      return false
    }
    throw error
  }
}

async function editPayment(
  w: World,
  c: Extract<Command, { kind: 'editPayment' }>,
  payments: { system: System; id: string }[]
): Promise<boolean> {
  if (payments.length === 0) {
    return false
  }
  const made = payments[c.payment % payments.length]!
  const id = await idOn(w, 'payment', made.system, made.id, c.side)
  if (id === null) {
    return false
  }
  if (c.side === 'invoicing') {
    const current = await w.invoicing.getPayment(id)
    if (!current || current.deletedAt) {
      return false
    }
    await w.invoicing.replacePayment(
      id,
      {
        customerId: current.customerId,
        amount: c.amount,
        date: current.date,
        allocations: current.allocations.map((a) => ({ ...a, amount: c.amount })),
      },
      current.version
    )
    return true
  }
  const current = await w.qboActor.get('Payment', id)
  if (!current) {
    return false
  }
  await w.qboActor.updatePayment(id, {
    CustomerRef: current.CustomerRef,
    TotalAmt: Number(c.amount),
    Line: current.Line.map((l) => ({ Amount: Number(c.amount), LinkedTxn: l.LinkedTxn })),
  })
  return true
}

async function qboRecords(w: World, entityType: EntityType) {
  const entity = QBO_NAME[entityType]
  const res = await w.qbo.query(`select * from ${entity}`)
  const body = res.body as { QueryResponse: Record<string, { Id: string; SyncToken: string }[]> }
  return body.QueryResponse[entity] ?? []
}

const writeCount = async (w: World) =>
  Number(
    (
      await w.db
        .selectFrom('audit_log')
        .select((eb) => eb.fn.countAll().as('n'))
        .where('action', 'in', [...WRITES, 'linked'])
        .executeTakeFirstOrThrow()
    ).n
  )

const pendingJobs = async (w: World) =>
  (await w.db.selectFrom('sync_jobs').select('id').where('status', '=', 'pending').execute()).length

// Advances past every backoff, polls and syncs until a pass writes nothing.
async function settle(sim: Simulation): Promise<void> {
  for (let pass = 0; pass < MAX_SETTLE_PASSES; pass++) {
    const before = await writeCount(sim.w)
    await sim.w.clock.advance(SETTLE_MS)
    await sim.w.poll()
    await deliverAndDrain(sim, 'normal')
    if ((await writeCount(sim.w)) === before && (await pendingJobs(sim.w)) === 0) {
      return
    }
  }
  throw new Error(`still writing after ${MAX_SETTLE_PASSES} settle passes`)
}

async function simulate(generated: Step[]): Promise<Simulation> {
  const w = await createWorld()
  const baselineQbo = new Set<string>()
  for (const entityType of ENTITY_TYPES) {
    for (const r of await qboRecords(w, entityType)) {
      baselineQbo.add(`${entityType}:${r.Id}`)
    }
  }
  const sim: Simulation = { w, baselineQbo, delivered: { qbo: [], invoicing: [] }, applied: 0 }
  try {
    const customers = [
      (await linkedCustomer(w, 'Acme')).customer,
      (await linkedCustomer(w, 'Globex')).customer,
    ]
    const pickup = await linkedItem(w, 'Pickup', 'Hauling')
    const disposal = await linkedItem(w, 'Disposal', 'Landfill')
    // invoicing item ids, then their QBO ids
    const items = [pickup.item.id, disposal.item.id, pickup.qboId, disposal.qboId]
    const invoices: Pair[] = []
    for (const [customer, lines] of [
      [customers[0]!, 0],
      [customers[0]!, 1],
      [customers[1]!, 2],
    ] as const) {
      const { invoice, qboId } = await linkedInvoice(w, {
        customer,
        lines: LINE_SETS[lines]!.map(([item, quantity, unitPrice, amount]) => ({
          itemId: items[item]!,
          quantity,
          unitPrice,
          amount,
        })),
      })
      invoices.push({ invoicingId: invoice.id, qboId })
    }
    const payments: { system: System; id: string }[] = []
    for (const step of generated) {
      if (await perform(w, step.command, invoices, items, payments)) {
        sim.applied++
      }
      if (step.armed) {
        arm(w, step.armed)
      }
      await deliverAndDrain(sim, step.delivery)
      await w.clock.advance(STEP_MS)
    }
    await settle(sim)
    return sim
  } catch (error) {
    await w.close()
    throw error
  }
}

// Checks

async function liveLinks(w: World) {
  return w.db
    .selectFrom('invoicing_qbo_links')
    .selectAll()
    .where('deleted_at', 'is', null)
    .execute()
}

const openIssues = (w: World) =>
  w.db.selectFrom('sync_issues').selectAll().where('resolved_at', 'is', null).execute()

async function assertConverged(w: World): Promise<void> {
  const parked = new Set((await openIssues(w)).map((i) => i.link_id))
  for (const link of await liveLinks(w)) {
    if (parked.has(link.id)) {
      continue
    }
    const what = `${link.entity_type} link ${link.id}`
    expect(link.invoicing_id, `${what} has both ids`).not.toBeNull()
    expect(link.qbo_id, `${what} has both ids`).not.toBeNull()
    const spec = specFor(link.entity_type)
    const read = async (system: System, id: string) => {
      const s = await spec.read(w.ctx, system, id)
      if (s.state !== 'live' || link.snapshot === null || !spec.normalize) {
        return s
      }
      return { ...s, fields: spec.normalize(s.fields, link.snapshot as never) }
    }
    const invoicing = await read('invoicing', link.invoicing_id!)
    const qbo = await read('qbo', link.qbo_id!)
    expect(invoicing.state, `${what} invoicing side`).toBe('live')
    expect(qbo.state, `${what} qbo side`).toBe('live')
    if (invoicing.state === 'live' && qbo.state === 'live') {
      expect(isDeepStrictEqual(invoicing.fields, qbo.fields), `${what} sides equal`).toBe(true)
    }
  }
}

async function liveInvoicingIds(w: World, entityType: EntityType): Promise<string[]> {
  const records: { id: string; deletedAt?: string | null }[] = await {
    account: () => w.invoicing.listAccounts(),
    item: () => w.invoicing.listItems(),
    customer: () => w.invoicing.listCustomers(),
    invoice: () => w.invoicing.listInvoices(),
    payment: () => w.invoicing.listPayments(),
  }[entityType]()
  return records.filter((r) => !r.deletedAt).map((r) => r.id)
}

async function assertOneToOne(sim: Simulation): Promise<void> {
  const { w } = sim
  const links = await liveLinks(w)
  const flagged = new Set(
    (await openIssues(w)).filter((i) => i.link_id === null).map((i) => `${i.system}:${i.entity_id}`)
  )
  for (const entityType of ENTITY_TYPES) {
    const ofType = links.filter((l) => l.entity_type === entityType)
    const sides: [System, string[], (string | null)[]][] = [
      ['invoicing', await liveInvoicingIds(w, entityType), ofType.map((l) => l.invoicing_id)],
      [
        'qbo',
        (await qboRecords(w, entityType))
          .map((r) => r.Id)
          .filter((id) => !sim.baselineQbo.has(`${entityType}:${id}`)),
        ofType.map((l) => l.qbo_id),
      ],
    ]
    for (const [system, records, linked] of sides) {
      const ids = linked.filter((id) => id !== null)
      expect(new Set(ids).size, `${system} ${entityType} ids linked once`).toBe(ids.length)
      const unlinked = records.filter((id) => !ids.includes(id) && !flagged.has(`${system}:${id}`))
      expect(unlinked, `unlinked ${system} ${entityType} records`).toEqual([])
    }
  }
}

async function versions(w: World): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const entityType of ENTITY_TYPES) {
    const invoicing: { id: string; version: number }[] = await {
      account: () => w.invoicing.listAccounts(),
      item: () => w.invoicing.listItems(),
      customer: () => w.invoicing.listCustomers(),
      invoice: () => w.invoicing.listInvoices(),
      payment: () => w.invoicing.listPayments(),
    }[entityType]()
    for (const r of invoicing) {
      out[`invoicing:${entityType}:${r.id}`] = String(r.version)
    }
    for (const r of await qboRecords(w, entityType)) {
      out[`qbo:${entityType}:${r.Id}`] = r.SyncToken
    }
  }
  return out
}

const writeEntries = (w: World) =>
  w.db
    .selectFrom('audit_log')
    .selectAll()
    .where('action', 'in', [...WRITES])
    .execute()

async function assertReplayWritesNothing(sim: Simulation): Promise<void> {
  const { w } = sim
  const before = await versions(w)
  const writesBefore = (await writeEntries(w)).length
  if (sim.delivered.qbo.length > 0) {
    await w.webhook('qbo', sim.delivered.qbo)
  }
  // the feed holds every invoicing event, the setup's included
  await w.webhook('invoicing', await w.invoicing.listEvents(null, Number.MAX_SAFE_INTEGER))
  await deliverAndDrain(sim, 'normal')
  for (let pass = 0; pass < MAX_SETTLE_PASSES && (await pendingJobs(w)) > 0; pass++) {
    await w.clock.advance(SETTLE_MS)
    await deliverAndDrain(sim, 'normal')
  }
  expect(await versions(w)).toEqual(before)
  expect((await writeEntries(w)).slice(writesBefore)).toEqual([])
}

// Properties

async function holds(check: (sim: Simulation) => Promise<void>): Promise<number> {
  let applied = 0
  await fc.assert(
    fc.asyncProperty(steps, async (generated) => {
      const sim = await simulate(generated)
      try {
        applied += sim.applied
        await check(sim)
      } finally {
        await sim.w.close()
      }
    }),
    { numRuns: NUM_RUNS }
  )
  return applied
}

describe('Invariants (property-based)', () => {
  it(
    'I1 convergence: every live link is equal on both sides or has an open issue',
    async () => {
      expect(await holds((sim) => assertConverged(sim.w))).toBeGreaterThan(0)
    },
    PROPERTY_TIMEOUT_MS
  )

  it(
    'I2 no duplicates: records and links are one to one',
    async () => {
      expect(await holds(assertOneToOne)).toBeGreaterThan(0)
    },
    PROPERTY_TIMEOUT_MS
  )

  it(
    'I3 replay writes nothing: re-posting every notification changes no record',
    async () => {
      expect(await holds(assertReplayWritesNothing)).toBeGreaterThan(0)
    },
    PROPERTY_TIMEOUT_MS
  )
})
