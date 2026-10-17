// Entity spec for invoices, matched by number, customer and total.
import type { System } from '../../db/database.js'
import type { Invoice } from '../../invoicing/types.js'
import { add, cmp, toMoney, type Money } from '../../money.js'
import type { QboInvoice } from '../../qbo/entities.js'
import type { SyncContext } from '../context.js'
import type { EntitySpec } from '../engine.js'
import { invoicingToNeutral, neutralToInvoicing } from '../map-invoicing.js'
import { neutralToQbo, qboToNeutral, unsupportedInvoice } from '../map-qbo.js'
import type { NeutralInvoice, Side } from '../neutral.js'
import { toLinkFn, toSideFn, type SideRef } from '../refs.js'
import { created, GONE, live, matchOf } from './side.js'

interface Candidate {
  id: string
  customerId: string
  total: Money
}

const refs = (customerId: string, itemIds: string[]): SideRef[] => [
  { entityType: 'customer', id: customerId },
  ...itemIds.map((id) => ({ entityType: 'item' as const, id })),
]

const linkIds = (n: NeutralInvoice): string[] => [n.customer, ...n.lines.map((l) => l.item)]

const totalOf = (n: NeutralInvoice): Money => add(...n.lines.map((l) => l.amount), n.tax)

const invoice = {
  invoicing: async (ctx: SyncContext, i: Invoice): Promise<Side<NeutralInvoice>> => {
    const itemIds = i.lines.map((l) => l.itemId)
    const toLink = await toLinkFn(ctx, 'invoicing', refs(i.customerId, itemIds))
    return live(i.id, i.version, invoicingToNeutral.invoice(i, toLink))
  },
  qbo: async (ctx: SyncContext, i: QboInvoice): Promise<Side<NeutralInvoice>> => {
    // checked before its customer and items are linked, which may create them
    const reason = unsupportedInvoice(i)
    if (reason !== null) return { state: 'unsupported', id: i.Id, reason }
    const itemIds = i.Line.flatMap((l) =>
      l.DetailType === 'SalesItemLineDetail' ? [l.SalesItemLineDetail.ItemRef.value] : []
    )
    const toLink = await toLinkFn(ctx, 'qbo', refs(i.CustomerRef.value, itemIds))
    const fields = qboToNeutral.invoice(i, toLink)
    if ('unsupported' in fields) {
      return { state: 'unsupported', id: i.Id, reason: fields.unsupported }
    }
    return live(i.Id, i.SyncToken, fields)
  },
}

async function candidates(ctx: SyncContext, system: System, number: string): Promise<Candidate[]> {
  if (system === 'qbo') {
    return (await ctx.qbo.findInvoicesByNumber(number)).map((i) => ({
      id: i.Id,
      customerId: i.CustomerRef.value,
      total: toMoney(i.TotalAmt),
    }))
  }
  const lower = number.toLowerCase()
  return (await ctx.invoicing.listInvoices({ number }))
    .filter((i) => i.number.toLowerCase() === lower)
    .map((i) => ({ id: i.id, customerId: i.customerId, total: i.total }))
}

export const invoiceSpec: EntitySpec<NeutralInvoice> = {
  entityType: 'invoice',

  async read(ctx, system, id) {
    if (system === 'invoicing') {
      const i = await ctx.invoicing.getInvoice(id)
      return i ? invoice.invoicing(ctx, i) : GONE
    }
    const i = await ctx.qbo.get('Invoice', id)
    return i ? invoice.qbo(ctx, i) : GONE
  },

  // the source's customer is linked, so the candidate's customer is the same one exactly when
  // it is that link's record on the candidate's side
  async match(ctx, system, fields) {
    const found = await candidates(ctx, system, fields.number)
    if (found.length !== 1) return matchOf(found.map((c) => c.id))
    const candidate = found[0]!
    const toSide = await toSideFn(ctx, system, [fields.customer])
    const same =
      candidate.customerId === toSide(fields.customer) &&
      cmp(candidate.total, totalOf(fields)) === 0
    return same ? { found: 'one', id: candidate.id } : { found: 'taken', ids: [candidate.id] }
  },

  async create(ctx, system, fields, key) {
    const toSide = await toSideFn(ctx, system, linkIds(fields))
    return created(
      system === 'invoicing'
        ? await invoice.invoicing(
            ctx,
            await ctx.invoicing.createInvoice(neutralToInvoicing.invoice(fields, toSide), key)
          )
        : await invoice.qbo(
            ctx,
            await ctx.qbo.create('Invoice', neutralToQbo.invoiceCreate(fields, toSide), key)
          )
    )
  },

  async update() {
    throw new Error('not implemented')
  },
}
