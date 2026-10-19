// Entity spec for payments and their allocations to invoices.
import { isDeepStrictEqual } from 'node:util'
import type { System } from '../../db/database.js'
import type { Payment } from '../../invoicing/types.js'
import type { QboPayment } from '../../qbo/entities.js'
import { findLink } from '../../store/links.js'
import type { SyncContext } from '../context.js'
import type { EntitySpec } from '../engine.js'
import { FlagError } from '../errors.js'
import { invoicingToNeutral, neutralToInvoicing } from '../map-invoicing.js'
import { isVoidedPayment, neutralToQbo, qboToNeutral } from '../map-qbo.js'
import {
  sortAllocations,
  type NeutralPayment,
  type Side,
  type ToLink,
  type ToSide,
} from '../neutral.js'
import { toLinkFn, toSideFn, type SideRef } from '../refs.js'
import { invoiceSpec } from './invoice.js'
import { created, GONE, live, matchOf, versionOf } from './side.js'

const refs = (customerId: string, invoiceIds: string[]): SideRef[] => [
  { entityType: 'customer', id: customerId },
  ...invoiceIds.map((id) => ({ entityType: 'invoice' as const, id })),
]

const linkIds = (n: NeutralPayment): string[] => [
  n.customer,
  ...n.allocations.map((a) => a.invoice),
]

const payment = {
  invoicing: async (ctx: SyncContext, p: Payment): Promise<Side<NeutralPayment>> => {
    if (p.deletedAt !== null) return GONE
    const invoiceIds = p.allocations.map((a) => a.invoiceId)
    const toLink = await toLinkFn(ctx, 'invoicing', refs(p.customerId, invoiceIds))
    return live(p.id, p.version, invoicingToNeutral.payment(p, toLink))
  },
  qbo: async (ctx: SyncContext, p: QboPayment): Promise<Side<NeutralPayment>> => {
    if (isVoidedPayment(p)) return GONE
    const invoiceIds = p.Line.flatMap((l) => {
      const links = l.LinkedTxn.filter((t) => t.TxnType === 'Invoice')
      return links.length === 1 ? [links[0]!.TxnId] : []
    })
    const toLink = await toLinkFn(ctx, 'qbo', refs(p.CustomerRef.value, invoiceIds))
    return live(p.Id, p.SyncToken, qboToNeutral.payment(p, toLink))
  },
}

// a payment on one side in its neutral form, with that side's ids in place of link ids
const asIs: ToLink = (_entityType, id) => id

// live payments on `system` with no link and the customer, amount and allocations of
// `fields`, ordered by id
async function unlinkedTwins(
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
  const customerId = key.customer
  const candidates =
    system === 'invoicing'
      ? (await ctx.invoicing.listPayments({ customerId }))
          .filter((p) => p.deletedAt === null)
          .map((p) => ({ id: p.id, ...invoicingToNeutral.payment(p, asIs) }))
      : (await ctx.qbo.findPaymentsByCustomer(customerId))
          .filter((p) => !isVoidedPayment(p))
          .map((p) => ({ id: p.Id, ...qboToNeutral.payment(p, asIs) }))
  const twins: { id: string; date: string }[] = []
  for (const { id, date, ...rest } of candidates) {
    if (!isDeepStrictEqual(rest, key)) continue
    if (await findLink(ctx.db, 'payment', system, id)) continue
    twins.push({ id, date })
  }
  return twins.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

// QBO stores a payment applied to a voided invoice unapplied, and invoicing rejects one
// allocated to a voided or deleted invoice, so such a write is flagged before it is sent
async function assertInvoicesOpen(
  ctx: SyncContext,
  system: System,
  fields: NeutralPayment,
  toSide: ToSide
): Promise<void> {
  const closed: { invoice: string; state: 'voided' | 'deleted' }[] = []
  for (const { invoice } of fields.allocations) {
    const side = await invoiceSpec.read(ctx, system, toSide(invoice))
    if (side.state === 'gone') closed.push({ invoice, state: 'deleted' })
    else if (side.state === 'live' && side.fields.voided) closed.push({ invoice, state: 'voided' })
  }
  if (closed.length === 0) return
  const states = [...new Set(closed.map((c) => c.state))].join(' or ')
  throw new FlagError('conflict', `allocated invoice ${states} in ${system}`, {
    invoices: closed.map((c) => c.invoice),
  })
}

export const paymentSpec: EntitySpec<NeutralPayment> = {
  entityType: 'payment',

  async read(ctx, system, id) {
    if (system === 'invoicing') {
      const p = await ctx.invoicing.getPayment(id)
      return p ? payment.invoicing(ctx, p) : GONE
    }
    const p = await ctx.qbo.get('Payment', id)
    return p ? payment.qbo(ctx, p) : GONE
  },

  // payments share no key, so a counterpart is an unlinked payment with the same customer,
  // amount and allocations: one on the same date is taken (identical payments are
  // interchangeable), otherwise a single one on each side is linked and its date differs
  async match(ctx, system, fields) {
    const found = await unlinkedTwins(ctx, system, fields)
    const exact = found.find((p) => p.date === fields.date)
    if (exact) return { found: 'one', id: exact.id }
    if (found.length !== 1) return matchOf(found.map((p) => p.id))
    const own = await unlinkedTwins(ctx, system === 'qbo' ? 'invoicing' : 'qbo', fields)
    return own.length === 1
      ? { found: 'one', id: found[0]!.id }
      : matchOf([...found, ...own].map((p) => p.id))
  },

  async create(ctx, system, fields, key) {
    const toSide = await toSideFn(ctx, system, linkIds(fields))
    await assertInvoicesOpen(ctx, system, fields, toSide)
    return created(
      system === 'invoicing'
        ? await payment.invoicing(
            ctx,
            await ctx.invoicing.createPayment(neutralToInvoicing.payment(fields, toSide), key)
          )
        : await payment.qbo(
            ctx,
            await ctx.qbo.create('Payment', neutralToQbo.paymentCreate(fields, toSide), key)
          )
    )
  },

  // writes the whole payment, so the amount and its allocations always change together
  async update(ctx, system, side, _changes, merged) {
    const toSide = await toSideFn(ctx, system, linkIds(merged))
    await assertInvoicesOpen(ctx, system, merged, toSide)
    const r =
      system === 'invoicing'
        ? await ctx.invoicing.replacePayment(
            side.id,
            neutralToInvoicing.payment(merged, toSide),
            Number(side.version)
          )
        : await ctx.qbo.update('Payment', {
            Id: side.id,
            SyncToken: side.version,
            ...neutralToQbo.paymentCreate(merged, toSide),
          })
    return { version: versionOf(r) }
  },

  async remove(ctx, system, side) {
    if (system === 'invoicing') await ctx.invoicing.deletePayment(side.id, Number(side.version))
    else await ctx.qbo.remove('Payment', side.id, side.version)
  },
}
