// Entity spec for invoices, matched by number, customer and total.
import type { Invoice } from '../../invoicing/types.js'
import { add, cmp, isZero, toMoney, type Money } from '../../money.js'
import type { QboInvoice } from '../../qbo/entities.js'
import { findLink, paymentLinksAllocating } from '../../store/links.js'
import type { SyncContext } from '../context.js'
import type { Diff } from '../diff.js'
import { reconcile, type EntitySpec, type Flag, type Live, type Match } from '../engine.js'
import { FlagError, StaleError } from '../errors.js'
import { notify } from '../intake.js'
import { fromInvoicingInvoice, toInvoicingInvoice } from '../map-invoicing.js'
import { fromQboInvoice, toQboInvoice, toQboInvoicePatch, unsupportedInvoice } from '../map-qbo.js'
import type { NeutralInvoice, Side } from '../neutral.js'
import { isLinked, toLinkFn, toSideFn, type SideRef } from '../refs.js'
import { expectLive, GONE, live, matchIds } from './side.js'

interface Candidate {
  id: string
  customerId: string
  total: Money
}

const ZERO: Money = '0.00'

const dependencies = (customerId: string, itemIds: string[]): SideRef[] => [
  { entityType: 'customer', id: customerId },
  ...itemIds.map((id) => ({ entityType: 'item' as const, id })),
]

const linkIds = (n: NeutralInvoice): string[] => [n.customer, ...n.lines.map((l) => l.item)]

const totalOf = (n: NeutralInvoice): Money => add(...n.lines.map((l) => l.amount), n.tax)

async function invoicingInvoice(ctx: SyncContext, i: Invoice): Promise<Side<NeutralInvoice>> {
  if (i.deletedAt !== null) {
    return GONE
  }
  const itemIds = i.lines.map((l) => l.itemId)
  const toLink = await toLinkFn(ctx, 'invoicing', dependencies(i.customerId, itemIds))
  return live(i.id, i.version, fromInvoicingInvoice(i, toLink))
}

async function qboInvoice(ctx: SyncContext, i: QboInvoice): Promise<Side<NeutralInvoice>> {
  // checked before its customer and items are linked, which may create them
  const reason = unsupportedInvoice(i)
  if (reason !== null) {
    return { state: 'unsupported', id: i.Id, reason }
  }
  const itemIds = i.Line.flatMap((l) =>
    l.DetailType === 'SalesItemLineDetail' ? [l.SalesItemLineDetail.ItemRef.value] : []
  )
  const toLink = await toLinkFn(ctx, 'qbo', dependencies(i.CustomerRef.value, itemIds))
  const fields = fromQboInvoice(i, toLink)
  if ('unsupported' in fields) {
    return { state: 'unsupported', id: i.Id, reason: fields.unsupported }
  }
  return live(i.Id, i.SyncToken, fields)
}

async function currentInvoicingInvoice(ctx: SyncContext, id: string): Promise<Invoice> {
  const i = await ctx.invoicing.getInvoice(id)
  if (!i) {
    throw new StaleError(`invoicing invoice ${id} is gone`)
  }
  return i
}

// Invoicing rejects voiding, deleting or reducing an invoice below what payments allocate to it.
// A linked payment's allocations follow its QBO counterpart, so it is reconciled first;
// allocations still over `cap` flag the invoice.
async function releaseAllocations(ctx: SyncContext, id: string, cap: Money = ZERO): Promise<void> {
  const { customerId } = await currentInvoicingInvoice(ctx, id)
  const allocating = async () =>
    (await ctx.invoicing.listPayments({ customerId })).filter(
      (p) => p.deletedAt === null && p.allocations.some((a) => a.invoiceId === id)
    )
  for (const p of await allocating()) {
    if (isLinked(await findLink(ctx.db, 'payment', 'invoicing', p.id))) {
      const ref = { system: 'invoicing' as const, entityType: 'payment' as const, entityId: p.id }
      await reconcile(ctx, ref, ctx.jobId)
    }
  }
  const left = await allocating()
  const amounts = left.flatMap((p) => p.allocations.filter((a) => a.invoiceId === id))
  if (cmp(add(...amounts.map((a) => a.amount)), cap) > 0) {
    throw new FlagError('conflict', 'payments still allocated in invoicing', {
      payments: left.map((p) => p.id),
    })
  }
}

// A QBO invoice write can move the payments applied to it without a webhook for them, so their
// sync is queued.
async function queuePayments(ctx: SyncContext, qboId: string): Promise<void> {
  const link = await findLink(ctx.db, 'invoice', 'qbo', qboId)
  if (!link) {
    return
  }
  for (const payment of await paymentLinksAllocating(ctx.db, link.id)) {
    if (payment.qboId !== null) {
      const ref = {
        system: 'qbo' as const,
        entityType: 'payment' as const,
        entityId: payment.qboId,
      }
      await notify(ctx, ref, { source: 'invoice', invoiceLinkId: link.id })
    }
  }
}

async function invoicingCandidates(ctx: SyncContext, number: string): Promise<Candidate[]> {
  const lower = number.toLowerCase()
  return (await ctx.invoicing.listInvoices({ number }))
    .filter((i) => i.number.toLowerCase() === lower)
    .map((i) => ({ id: i.id, customerId: i.customerId, total: i.total }))
}

async function qboCandidates(ctx: SyncContext, number: string): Promise<Candidate[]> {
  return (await ctx.qbo.findInvoicesByNumber(number)).map((i) => ({
    id: i.Id,
    customerId: i.CustomerRef.value,
    total: toMoney(i.TotalAmt),
  }))
}

// A single candidate with the number is the counterpart when its customer and total agree. A
// number used more than once on the source side is ambiguous from either record. The source's
// customer is linked, so the candidate's customer is the same one exactly when it is that link's
// record on the candidate's side.
async function matchByNumber(
  ctx: SyncContext,
  fields: NeutralInvoice,
  target: 'invoicing' | 'qbo',
  candidates: (number: string) => Promise<Candidate[]>,
  sameNumberOnSource: (number: string) => Promise<Candidate[]>
): Promise<Match> {
  const found = await candidates(fields.number)
  const [candidate] = found
  if (found.length !== 1 || !candidate) {
    return matchIds(found.map((c) => c.id))
  }
  const onSource = await sameNumberOnSource(fields.number)
  if (onSource.length > 1) {
    return matchIds([candidate.id, ...onSource.map((c) => c.id)])
  }
  const toSide = await toSideFn(ctx, target, [fields.customer])
  const same =
    candidate.customerId === toSide(fields.customer) && cmp(candidate.total, totalOf(fields)) === 0
  return same ? { found: 'one', id: candidate.id } : { found: 'taken', ids: [candidate.id] }
}

async function voidInvoicingInvoice(ctx: SyncContext, side: Live<NeutralInvoice>): Promise<string> {
  await releaseAllocations(ctx, side.id)
  return String((await ctx.invoicing.voidInvoice(side.id, Number(side.version))).version)
}

// writes at the version the pair was read at, so an edit made since then surfaces as stale
async function replaceInvoicingInvoice(
  ctx: SyncContext,
  side: Live<NeutralInvoice>,
  merged: NeutralInvoice
): Promise<string> {
  const toSide = await toSideFn(ctx, 'invoicing', linkIds(merged))
  const total = totalOf(merged)
  if (cmp(total, (await currentInvoicingInvoice(ctx, side.id)).paid) < 0) {
    await releaseAllocations(ctx, side.id, total)
  }
  const current = await currentInvoicingInvoice(ctx, side.id)
  const { number: _number, ...input } = toInvoicingInvoice(merged, toSide, current)
  return String((await ctx.invoicing.replaceInvoice(side.id, input, Number(side.version))).version)
}

async function voidQboInvoice(ctx: SyncContext, side: Live<NeutralInvoice>): Promise<string> {
  const voided = await ctx.qbo.voidInvoice(side.id, side.version)
  await queuePayments(ctx, side.id)
  return voided.SyncToken
}

// writes at the version the pair was read at, so an edit made since then surfaces as stale
async function updateQboInvoice(
  ctx: SyncContext,
  side: Live<NeutralInvoice>,
  changes: Partial<NeutralInvoice>,
  merged: NeutralInvoice
): Promise<string> {
  const toSide = await toSideFn(ctx, 'qbo', linkIds(merged))
  const current = await ctx.qbo.get('Invoice', side.id)
  if (!current) {
    throw new StaleError(`qbo invoice ${side.id} is gone`)
  }
  const patch = toQboInvoicePatch(changes, current, toSide)
  const updated = await ctx.qbo.update('Invoice', {
    Id: side.id,
    SyncToken: side.version,
    ...patch,
  })
  await queuePayments(ctx, side.id)
  return updated.SyncToken
}

// A void is final: an edit made meanwhile on the other side, or in QBO after it, is held.
function voidHeld(
  snapshot: NeutralInvoice | null,
  qbo: NeutralInvoice,
  { toQbo, toInvoicing }: Diff<NeutralInvoice>
): Flag | null {
  if (snapshot?.voided && !qbo.voided) {
    return { kind: 'revived_void', reason: 'voided invoice edited in qbo' }
  }
  if ('voided' in toQbo && Object.keys(toInvoicing).length > 0) {
    return { kind: 'conflict', reason: 'voided in invoicing, changed in qbo' }
  }
  if ('voided' in toInvoicing && Object.keys(toQbo).length > 0) {
    return { kind: 'conflict', reason: 'voided in qbo, changed in invoicing' }
  }
  return null
}

// Tax is set in QBO only, and writing the lines of a taxed invoice would recompute it.
function taxHeld(
  snapshot: NeutralInvoice | null,
  qbo: NeutralInvoice,
  toQbo: Partial<NeutralInvoice>
): Flag | null {
  const taxed = !isZero((snapshot ?? qbo).tax)
  if ('tax' in toQbo || ('lines' in toQbo && taxed)) {
    return { kind: 'taxed_lines_edited', reason: 'tax is set in QBO; edit these lines in QBO' }
  }
  return null
}

export const invoiceSpec: EntitySpec<NeutralInvoice> = {
  entityType: 'invoice',

  invoicing: {
    async read(ctx, id) {
      const i = await ctx.invoicing.getInvoice(id)
      return i ? invoicingInvoice(ctx, i) : GONE
    },
    match: (ctx, fields) =>
      matchByNumber(
        ctx,
        fields,
        'invoicing',
        (number) => invoicingCandidates(ctx, number),
        (number) => qboCandidates(ctx, number)
      ),
    async create(ctx, fields, key) {
      const toSide = await toSideFn(ctx, 'invoicing', linkIds(fields))
      const i = await ctx.invoicing.createInvoice(toInvoicingInvoice(fields, toSide), key)
      return expectLive(await invoicingInvoice(ctx, i))
    },
    update(ctx, side, changes, merged) {
      if (changes.voided === true) {
        return voidInvoicingInvoice(ctx, side)
      }
      return replaceInvoicingInvoice(ctx, side, merged)
    },
    async remove(ctx, side) {
      await releaseAllocations(ctx, side.id)
      await ctx.invoicing.deleteInvoice(side.id, Number(side.version))
    },
  },

  qbo: {
    async read(ctx, id) {
      const i = await ctx.qbo.get('Invoice', id)
      return i ? qboInvoice(ctx, i) : GONE
    },
    match: (ctx, fields) =>
      matchByNumber(
        ctx,
        fields,
        'qbo',
        (number) => qboCandidates(ctx, number),
        (number) => invoicingCandidates(ctx, number)
      ),
    async create(ctx, fields, key) {
      const toSide = await toSideFn(ctx, 'qbo', linkIds(fields))
      const i = await ctx.qbo.create('Invoice', toQboInvoice(fields, toSide), key)
      return expectLive(await qboInvoice(ctx, i))
    },
    update(ctx, side, changes, merged) {
      if (changes.voided === true) {
        return voidQboInvoice(ctx, side)
      }
      return updateQboInvoice(ctx, side, changes, merged)
    },
    async remove(ctx, side) {
      await ctx.qbo.remove('Invoice', side.id, side.version)
      await queuePayments(ctx, side.id)
    },
  },

  // tax is written only from QBO, so an invoice carrying tax can't be created there
  createBlocked: (fields, target) =>
    target === 'qbo' && !isZero(fields.tax) ? 'tax is set in QBO only' : null,

  final: (fields) => fields.voided,

  // QBO zeroes a voided invoice's lines and invoicing keeps them; either way its other fields
  // are what they were when it was voided
  normalize: (fields, snapshot) => (fields.voided ? { ...snapshot, voided: true } : fields),

  updateAction: (changes) => (changes.voided === true ? 'voided' : 'updated'),

  // invoicing numbers are immutable, so a differing number was changed in QBO
  async guard(_ctx, link, { invoicing, qbo }, diff) {
    const snapshot = link.snapshot as NeutralInvoice | null
    const voided = voidHeld(snapshot, qbo.fields, diff)
    if (voided) {
      return voided
    }
    if (invoicing.fields.number !== qbo.fields.number) {
      return { kind: 'number_changed', reason: `number changed in qbo to ${qbo.fields.number}` }
    }
    return taxHeld(snapshot, qbo.fields, diff.toQbo)
  },
}
