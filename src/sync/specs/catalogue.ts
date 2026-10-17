// Entity specs for the catalogue: accounts, items and customers, matched by name.
import type { System } from '../../db/database.js'
import type { EntitySpec, Match } from '../engine.js'
import { invoicingToNeutral, neutralToInvoicing } from '../map-invoicing.js'
import { neutralToQbo, qboToNeutral } from '../map-qbo.js'
import type { NeutralAccount, NeutralCustomer, NeutralItem, Side } from '../neutral.js'
import { toLinkFn, toSideFn } from '../refs.js'

const GONE = { state: 'gone' } as const

const live = <N>(id: string, version: string | number, fields: N): Side<N> => ({
  state: 'live',
  id,
  version: String(version),
  fields,
})

const written = (r: { id: string; version: number } | { Id: string; SyncToken: string }) =>
  'Id' in r ? { id: r.Id, version: r.SyncToken } : { id: r.id, version: String(r.version) }

function matchOf(ids: string[]): Match {
  if (ids.length === 0) return { found: 'none' }
  if (ids.length === 1) return { found: 'one', id: ids[0]! }
  return { found: 'many', ids }
}

const named = (name: string) => (r: { name: string }) => r.name.toLowerCase() === name.toLowerCase()

const byName = async (
  system: System,
  name: string,
  invoicing: () => Promise<{ id: string; name: string }[]>,
  qbo: () => Promise<{ Id: string }[]>
): Promise<Match> =>
  matchOf(
    system === 'invoicing'
      ? (await invoicing()).filter(named(name)).map((r) => r.id)
      : (await qbo()).map((r) => r.Id)
  )

export const accountSpec: EntitySpec<NeutralAccount> = {
  entityType: 'account',

  async read(ctx, system, id) {
    if (system === 'invoicing') {
      const a = await ctx.invoicing.getAccount(id)
      return a ? live(a.id, a.version, invoicingToNeutral.account(a)) : GONE
    }
    const a = await ctx.qbo.get('Account', id)
    if (!a) return GONE
    // balance-sheet accounts change with every posting; only income accounts are synced
    if (a.AccountType !== 'Income') return { state: 'ignored', id, reason: 'not an income account' }
    return live(a.Id, a.SyncToken, qboToNeutral.account(a))
  },

  match: (ctx, system, fields) =>
    byName(
      system,
      fields.name,
      () => ctx.invoicing.listAccounts(),
      () => ctx.qbo.findByName('Account', fields.name)
    ),

  async create(ctx, system, fields, key) {
    return written(
      system === 'invoicing'
        ? await ctx.invoicing.createAccount(neutralToInvoicing.account(fields), key)
        : await ctx.qbo.create('Account', neutralToQbo.accountCreate(fields), key)
    )
  },

  async update(ctx, system, side, changes) {
    const r =
      system === 'invoicing'
        ? await ctx.invoicing.updateAccount(
            side.id,
            neutralToInvoicing.accountPatch(changes),
            Number(side.version)
          )
        : await ctx.qbo.update('Account', {
            Id: side.id,
            SyncToken: side.version,
            ...neutralToQbo.accountPatch(changes),
          })
    return { version: written(r).version }
  },
}

export const itemSpec: EntitySpec<NeutralItem> = {
  entityType: 'item',

  async read(ctx, system, id) {
    if (system === 'invoicing') {
      const i = await ctx.invoicing.getItem(id)
      if (!i) return GONE
      const toLink = await toLinkFn(ctx, system, [{ entityType: 'account', id: i.incomeAccountId }])
      return live(i.id, i.version, invoicingToNeutral.item(i, toLink))
    }
    const i = await ctx.qbo.get('Item', id)
    if (!i) return GONE
    const account = i.Type !== 'Inventory' ? i.IncomeAccountRef?.value : undefined
    const toLink = await toLinkFn(
      ctx,
      system,
      account ? [{ entityType: 'account', id: account }] : []
    )
    const fields = qboToNeutral.item(i, toLink)
    if ('unsupported' in fields) return { state: 'unsupported', id, reason: fields.unsupported }
    return live(i.Id, i.SyncToken, fields)
  },

  match: (ctx, system, fields) =>
    byName(
      system,
      fields.name,
      () => ctx.invoicing.listItems(),
      () => ctx.qbo.findByName('Item', fields.name)
    ),

  async create(ctx, system, fields, key) {
    const toSide = await toSideFn(ctx, system, [fields.incomeAccount])
    return written(
      system === 'invoicing'
        ? await ctx.invoicing.createItem(neutralToInvoicing.item(fields, toSide), key)
        : await ctx.qbo.create('Item', neutralToQbo.itemCreate(fields, toSide), key)
    )
  },

  async update(ctx, system, side, changes) {
    const toSide = await toSideFn(
      ctx,
      system,
      changes.incomeAccount === undefined ? [] : [changes.incomeAccount]
    )
    const r =
      system === 'invoicing'
        ? await ctx.invoicing.updateItem(
            side.id,
            neutralToInvoicing.itemPatch(changes, toSide),
            Number(side.version)
          )
        : await ctx.qbo.update('Item', {
            Id: side.id,
            SyncToken: side.version,
            ...neutralToQbo.itemPatch(changes, toSide),
          })
    return { version: written(r).version }
  },
}

export const customerSpec: EntitySpec<NeutralCustomer> = {
  entityType: 'customer',

  async read(ctx, system, id) {
    if (system === 'invoicing') {
      const c = await ctx.invoicing.getCustomer(id)
      return c ? live(c.id, c.version, invoicingToNeutral.customer(c)) : GONE
    }
    const c = await ctx.qbo.get('Customer', id)
    return c ? live(c.Id, c.SyncToken, qboToNeutral.customer(c)) : GONE
  },

  match: (ctx, system, fields) =>
    byName(
      system,
      fields.name,
      () => ctx.invoicing.listCustomers(),
      () => ctx.qbo.findByName('Customer', fields.name)
    ),

  async create(ctx, system, fields, key) {
    return written(
      system === 'invoicing'
        ? await ctx.invoicing.createCustomer(neutralToInvoicing.customer(fields), key)
        : await ctx.qbo.create('Customer', neutralToQbo.customerCreate(fields), key)
    )
  },

  async update(ctx, system, side, changes) {
    const r =
      system === 'invoicing'
        ? await ctx.invoicing.updateCustomer(
            side.id,
            neutralToInvoicing.customerPatch(changes),
            Number(side.version)
          )
        : await ctx.qbo.update('Customer', {
            Id: side.id,
            SyncToken: side.version,
            ...neutralToQbo.customerPatch(changes),
          })
    return { version: written(r).version }
  },
}
