// Entity spec for invoices, matched by number, customer and total.
import type { System } from '../../db/database.js'
import type { Invoice } from '../../invoicing/types.js'
import { add, cmp, isZero, toMoney, type Money } from '../../money.js'
import type { QboInvoice } from '../../qbo/entities.js'
import { findLink } from '../../store/links.js'
import type { SyncContext } from '../context.js'
import { reconcile, type EntitySpec } from '../engine.js'
import { FlagError, StaleError } from '../errors.js'
import { invoicingToNeutral, neutralToInvoicing } from '../map-invoicing.js'
import { neutralToQbo, qboToNeutral, unsupportedInvoice } from '../map-qbo.js'
import type { NeutralInvoice, Side } from '../neutral.js'
import { isLinked, toLinkFn, toSideFn, type SideRef } from '../refs.js'
import { created, GONE, live, matchOf, versionOf } from './side.js'

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
    if (i.deletedAt !== null) return GONE
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

// invoicing rejects voiding or deleting an invoice that payments are allocated to; a linked
// payment's allocations follow its QBO counterpart, so it is reconciled first, and any
// allocation still left flags the invoice
async function freePayments(ctx: SyncContext, id: string): Promise<void> {
  const current = await ctx.invoicing.getInvoice(id)
  if (!current) throw new StaleError(`invoicing invoice ${id} is gone`)
  const allocated = async () =>
    (await ctx.invoicing.listPayments({ customerId: current.customerId })).filter(
      (p) => p.deletedAt === null && p.allocations.some((a) => a.invoiceId === id)
    )
  for (const p of await allocated()) {
    if (!isLinked(await findLink(ctx.db, 'payment', 'invoicing', p.id))) continue
    await reconcile(ctx, { system: 'invoicing', entityType: 'payment', entityId: p.id }, ctx.jobId)
  }
  const left = await allocated()
  if (left.length > 0) {
    throw new FlagError('conflict', 'payments still allocated in invoicing', {
      payments: left.map((p) => p.id),
    })
  }
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

  // tax is written only from QBO, so an invoice carrying tax can't be created there
  createBlocked: (fields, target) =>
    target === 'qbo' && !isZero(fields.tax) ? 'tax is set in QBO only' : null,

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

  // QBO zeroes a voided invoice's lines and invoicing keeps them; either way its other fields
  // are what they were when it was voided
  final: (fields) => fields.voided,

  normalize: (fields, snapshot) => (fields.voided ? { ...snapshot, voided: true } : fields),

  updateAction: (changes) => (changes.voided === true ? 'voided' : 'updated'),

  // writes at the version the pair was read at, so an edit made since then surfaces as stale
  async update(ctx, system, side, changes, merged) {
    if (changes.voided === true) {
      if (system === 'qbo') {
        return { version: versionOf(await ctx.qbo.voidInvoice(side.id, side.version)) }
      }
      await freePayments(ctx, side.id)
      return {
        version: versionOf(await ctx.invoicing.voidInvoice(side.id, Number(side.version))),
      }
    }
    const toSide = await toSideFn(ctx, system, linkIds(merged))
    if (system === 'invoicing') {
      const current = await ctx.invoicing.getInvoice(side.id)
      if (!current) throw new StaleError(`invoicing invoice ${side.id} is gone`)
      const { number: _number, ...input } = neutralToInvoicing.invoice(merged, toSide, current)
      return {
        version: versionOf(
          await ctx.invoicing.replaceInvoice(side.id, input, Number(side.version))
        ),
      }
    }
    const current = await ctx.qbo.get('Invoice', side.id)
    if (!current) throw new StaleError(`qbo invoice ${side.id} is gone`)
    const updated = await ctx.qbo.update('Invoice', {
      Id: side.id,
      SyncToken: side.version,
      ...neutralToQbo.invoicePatch(changes, current, toSide),
    })
    return { version: versionOf(updated) }
  },

  async remove(ctx, system, side) {
    if (system === 'qbo') return ctx.qbo.remove('Invoice', side.id, side.version)
    await freePayments(ctx, side.id)
    await ctx.invoicing.deleteInvoice(side.id, Number(side.version))
  },

  // a void is final: an edit made meanwhile on the other side, or in QBO after it, is flagged; invoicing
  // numbers are immutable, so a differing number was changed in QBO; tax is QBO's, and
  // writing the lines of a taxed invoice would recompute it
  async guard(_ctx, link, { invoicing, qbo }, diff) {
    const { toQbo, toInvoicing } = diff
    if ((link.snapshot as NeutralInvoice | null)?.voided && !qbo.fields.voided) {
      return { kind: 'revived_void', reason: 'voided invoice edited in qbo' }
    }
    if ('voided' in toQbo && Object.keys(toInvoicing).length > 0) {
      return { kind: 'conflict', reason: 'voided in invoicing, changed in qbo' }
    }
    if ('voided' in toInvoicing && Object.keys(toQbo).length > 0) {
      return { kind: 'conflict', reason: 'voided in qbo, changed in invoicing' }
    }
    if (invoicing.fields.number !== qbo.fields.number) {
      return { kind: 'number_changed', reason: `number changed in qbo to ${qbo.fields.number}` }
    }
    if (
      'tax' in toQbo ||
      ('lines' in toQbo && !isZero(((link.snapshot as NeutralInvoice | null) ?? qbo.fields).tax))
    ) {
      return { kind: 'taxed_lines_edited', reason: 'tax is set in QBO; edit these lines in QBO' }
    }
    return null
  },
}
