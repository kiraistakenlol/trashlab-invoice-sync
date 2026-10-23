// Entity spec for payments and their allocations to invoices.
import { isDeepStrictEqual } from 'node:util'
import type { System } from '../../db/database.js'
import type { Payment } from '../../invoicing/types.js'
import type { QboPayment } from '../../qbo/entities.js'
import { findLink, pendingLinks } from '../../store/links.js'
import type { SyncContext } from '../context.js'
import { otherSystem, type EntitySpec, type Match } from '../engine.js'
import { FlagError } from '../errors.js'
import { fromInvoicingPayment, toInvoicingPayment } from '../map-invoicing.js'
import { fromQboPayment, isVoidedPayment, toQboPayment } from '../map-qbo.js'
import {
  compareIds,
  sortAllocations,
  type NeutralPayment,
  type Side,
  type ToLink,
  type ToSide,
} from '../neutral.js'
import { toLinkFn, toSideFn, type SideRef } from '../refs.js'
import { invoiceSpec } from './invoice.js'
import { expectLive, GONE, live, matchIds } from './side.js'

type PaymentOn = NeutralPayment & { id: string }

const dependencies = (customerId: string, invoiceIds: string[]): SideRef[] => [
  { entityType: 'customer', id: customerId },
  ...invoiceIds.map((id) => ({ entityType: 'invoice' as const, id })),
]

const linkIds = (n: NeutralPayment): string[] => [
  n.customer,
  ...n.allocations.map((a) => a.invoice),
]

// a payment in its neutral form with one side's own ids in place of link ids
const keepSideIds: ToLink = (_entityType, id) => id

async function invoicingPayment(ctx: SyncContext, p: Payment): Promise<Side<NeutralPayment>> {
  if (p.deletedAt !== null) {
    return GONE
  }
  const invoiceIds = p.allocations.map((a) => a.invoiceId)
  const toLink = await toLinkFn(ctx, 'invoicing', dependencies(p.customerId, invoiceIds))
  return live(p.id, p.version, fromInvoicingPayment(p, toLink))
}

async function qboPayment(ctx: SyncContext, p: QboPayment): Promise<Side<NeutralPayment>> {
  if (isVoidedPayment(p)) {
    return GONE
  }
  const invoiceIds = p.Line.flatMap((l) => {
    const invoices = l.LinkedTxn.filter((t) => t.TxnType === 'Invoice')
    return invoices.length === 1 ? invoices.map((t) => t.TxnId) : []
  })
  const toLink = await toLinkFn(ctx, 'qbo', dependencies(p.CustomerRef.value, invoiceIds))
  return live(p.Id, p.SyncToken, fromQboPayment(p, toLink))
}

const livePaymentsOf: Record<
  System,
  (ctx: SyncContext, customerId: string) => Promise<PaymentOn[]>
> = {
  invoicing: async (ctx, customerId) =>
    (await ctx.invoicing.listPayments({ customerId }))
      .filter((p) => p.deletedAt === null)
      .map((p) => ({ id: p.id, ...fromInvoicingPayment(p, keepSideIds) })),
  qbo: async (ctx, customerId) =>
    (await ctx.qbo.findPaymentsByCustomer(customerId))
      .filter((p) => !isVoidedPayment(p))
      .map((p) => ({ id: p.Id, ...fromQboPayment(p, keepSideIds) })),
}

// Live payments on `system` with no link and the customer, amount and allocations of `fields`,
// ordered by id. One equal to a link's pending create is that create, landed early, and is left
// to its link.
async function matchingPayments(
  ctx: SyncContext,
  system: System,
  fields: NeutralPayment
): Promise<{ id: string; date: string }[]> {
  const toSide = await toSideFn(ctx, system, linkIds(fields))
  const key = {
    customer: toSide(fields.customer),
    amount: fields.amount,
    allocations: sortAllocations(
      fields.allocations.map((a) => ({ invoice: toSide(a.invoice), amount: a.amount }))
    ),
  }
  const candidates = await livePaymentsOf[system](ctx, key.customer)
  const inFlight = (await pendingLinks(ctx.db, 'payment', system)).map((l) => l.snapshot)
  const matching: { id: string; date: string }[] = []
  for (const { id, date, ...rest } of candidates) {
    const same =
      isDeepStrictEqual(rest, key) &&
      !inFlight.some((s) => isDeepStrictEqual(s, { ...fields, date }))
    if (same && !(await findLink(ctx.db, 'payment', system, id))) {
      matching.push({ id, date })
    }
  }
  return matching.sort((a, b) => compareIds(a.id, b.id))
}

// Payments share no key, so a counterpart is an unlinked payment with the same customer, amount
// and allocations: one on the same date is taken (identical payments are interchangeable),
// otherwise a single one on each side is linked and its date differs.
async function matchPayment(
  ctx: SyncContext,
  target: System,
  fields: NeutralPayment
): Promise<Match> {
  const found = await matchingPayments(ctx, target, fields)
  const exact = found.find((p) => p.date === fields.date)
  if (exact) {
    return { found: 'one', id: exact.id }
  }
  const [only] = found
  if (found.length !== 1 || !only) {
    return matchIds(found.map((p) => p.id))
  }
  const onSource = await matchingPayments(ctx, otherSystem(target), fields)
  if (onSource.length === 1) {
    return { found: 'one', id: only.id }
  }
  return matchIds([...found, ...onSource].map((p) => p.id))
}

// QBO stores a payment applied to a voided invoice unapplied, and invoicing rejects one
// allocated to a voided or deleted invoice, so such a write is flagged before it is sent.
async function assertInvoicesOpen(
  ctx: SyncContext,
  system: System,
  fields: NeutralPayment,
  toSide: ToSide
): Promise<void> {
  const closed: { invoice: string; state: 'voided' | 'deleted' }[] = []
  for (const { invoice } of fields.allocations) {
    const side = await invoiceSpec[system].read(ctx, toSide(invoice))
    if (side.state === 'gone') {
      closed.push({ invoice, state: 'deleted' })
    } else if (side.state === 'live' && side.fields.voided) {
      closed.push({ invoice, state: 'voided' })
    }
  }
  if (closed.length === 0) {
    return
  }
  const states = [...new Set(closed.map((c) => c.state))].join(' or ')
  throw new FlagError('conflict', `allocated invoice ${states} in ${system}`, {
    invoices: closed.map((c) => c.invoice),
  })
}

// Resolves a payment's link ids on `system` for a write, once its invoices are known open.
async function toSideForWrite(
  ctx: SyncContext,
  system: System,
  fields: NeutralPayment
): Promise<ToSide> {
  const toSide = await toSideFn(ctx, system, linkIds(fields))
  await assertInvoicesOpen(ctx, system, fields, toSide)
  return toSide
}

// Updates write the whole payment, so the amount and its allocations always change together.
export const paymentSpec: EntitySpec<NeutralPayment> = {
  entityType: 'payment',

  invoicing: {
    async read(ctx, id) {
      const p = await ctx.invoicing.getPayment(id)
      return p ? invoicingPayment(ctx, p) : GONE
    },
    match: (ctx, fields) => matchPayment(ctx, 'invoicing', fields),
    async create(ctx, fields, key) {
      const toSide = await toSideForWrite(ctx, 'invoicing', fields)
      const p = await ctx.invoicing.createPayment(toInvoicingPayment(fields, toSide), key)
      return expectLive(await invoicingPayment(ctx, p))
    },
    async update(ctx, side, _changes, merged) {
      const toSide = await toSideForWrite(ctx, 'invoicing', merged)
      const input = toInvoicingPayment(merged, toSide)
      return String(
        (await ctx.invoicing.replacePayment(side.id, input, Number(side.version))).version
      )
    },
    async remove(ctx, side) {
      await ctx.invoicing.deletePayment(side.id, Number(side.version))
    },
  },

  qbo: {
    async read(ctx, id) {
      const p = await ctx.qbo.get('Payment', id)
      return p ? qboPayment(ctx, p) : GONE
    },
    match: (ctx, fields) => matchPayment(ctx, 'qbo', fields),
    async create(ctx, fields, key) {
      const toSide = await toSideForWrite(ctx, 'qbo', fields)
      const p = await ctx.qbo.create('Payment', toQboPayment(fields, toSide), key)
      return expectLive(await qboPayment(ctx, p))
    },
    async update(ctx, side, _changes, merged) {
      const toSide = await toSideForWrite(ctx, 'qbo', merged)
      const body = { Id: side.id, SyncToken: side.version, ...toQboPayment(merged, toSide) }
      return (await ctx.qbo.update('Payment', body)).SyncToken
    },
    async remove(ctx, side) {
      await ctx.qbo.remove('Payment', side.id, side.version)
    },
  },
}
