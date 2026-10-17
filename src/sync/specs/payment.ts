// Entity spec for payments and their allocations to invoices.
import type { Payment } from '../../invoicing/types.js'
import type { QboPayment } from '../../qbo/entities.js'
import type { SyncContext } from '../context.js'
import type { EntitySpec } from '../engine.js'
import { invoicingToNeutral, neutralToInvoicing } from '../map-invoicing.js'
import { neutralToQbo, qboToNeutral } from '../map-qbo.js'
import type { NeutralPayment, Side } from '../neutral.js'
import { toLinkFn, toSideFn, type SideRef } from '../refs.js'
import { created, GONE, live, versionOf } from './side.js'

const refs = (customerId: string, invoiceIds: string[]): SideRef[] => [
  { entityType: 'customer', id: customerId },
  ...invoiceIds.map((id) => ({ entityType: 'invoice' as const, id })),
]

const linkIds = (n: NeutralPayment): string[] => [
  n.customer,
  ...n.allocations.map((a) => a.invoice),
]

// a void zeroes the payment and drops its lines; QBO keeps it, with a note
const voided = (p: QboPayment): boolean =>
  p.TotalAmt === 0 && p.Line.length === 0 && (p.PrivateNote ?? '').startsWith('Voided')

const payment = {
  invoicing: async (ctx: SyncContext, p: Payment): Promise<Side<NeutralPayment>> => {
    if (p.deletedAt !== null) return GONE
    const invoiceIds = p.allocations.map((a) => a.invoiceId)
    const toLink = await toLinkFn(ctx, 'invoicing', refs(p.customerId, invoiceIds))
    return live(p.id, p.version, invoicingToNeutral.payment(p, toLink))
  },
  qbo: async (ctx: SyncContext, p: QboPayment): Promise<Side<NeutralPayment>> => {
    if (voided(p)) return GONE
    const invoiceIds = p.Line.flatMap((l) => {
      const links = l.LinkedTxn.filter((t) => t.TxnType === 'Invoice')
      return links.length === 1 ? [links[0]!.TxnId] : []
    })
    const toLink = await toLinkFn(ctx, 'qbo', refs(p.CustomerRef.value, invoiceIds))
    return live(p.Id, p.SyncToken, qboToNeutral.payment(p, toLink))
  },
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

  // payments share no key; the link's idempotency key keeps a create from repeating
  match: async () => ({ found: 'none' }),

  async create(ctx, system, fields, key) {
    const toSide = await toSideFn(ctx, system, linkIds(fields))
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
            ...neutralToQbo.paymentPatch(merged, toSide),
          })
    return { version: versionOf(r) }
  },

  async remove(ctx, system, side) {
    if (system === 'invoicing') await ctx.invoicing.deletePayment(side.id, Number(side.version))
    else await ctx.qbo.remove('Payment', side.id, side.version)
  },
}
