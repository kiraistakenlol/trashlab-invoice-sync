// Entity specs for the catalogue: accounts, items and customers, matched by name.
import type { System } from '../../db/database.js'
import type { EntitySpec, Live, Match } from '../engine.js'
import { invoicingToNeutral, neutralToInvoicing } from '../map-invoicing.js'
import { neutralToQbo, qboToNeutral } from '../map-qbo.js'
import type { Account, Customer, Item } from '../../invoicing/types.js'
import type { QboAccount, QboCustomer, QboItem } from '../../qbo/entities.js'
import type { SyncContext } from '../context.js'
import type { NeutralAccount, NeutralCustomer, NeutralItem, Side } from '../neutral.js'
import { toLinkFn, toSideFn } from '../refs.js'

const GONE = { state: 'gone' } as const

const live = <N>(id: string, version: string | number, fields: N): Side<N> => ({
  state: 'live',
  id,
  version: String(version),
  fields,
})

const versionOf = (r: { version: number } | { SyncToken: string }) =>
  'SyncToken' in r ? r.SyncToken : String(r.version)

// a created record maps like a read one
function created<N>(side: Side<N>): Live<N> {
  if (side.state !== 'live') throw new Error(`created record reads as ${side.state}`)
  return side
}

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

const account = {
  invoicing: (a: Account): Side<NeutralAccount> =>
    live(a.id, a.version, invoicingToNeutral.account(a)),
  // balance-sheet accounts change with every posting; only income accounts are synced
  qbo: (a: QboAccount): Side<NeutralAccount> =>
    a.AccountType === 'Income'
      ? live(a.Id, a.SyncToken, qboToNeutral.account(a))
      : { state: 'ignored', id: a.Id, reason: 'not an income account' },
}

const item = {
  invoicing: async (ctx: SyncContext, i: Item): Promise<Side<NeutralItem>> => {
    const toLink = await toLinkFn(ctx, 'invoicing', [
      { entityType: 'account', id: i.incomeAccountId },
    ])
    return live(i.id, i.version, invoicingToNeutral.item(i, toLink))
  },
  qbo: async (ctx: SyncContext, i: QboItem): Promise<Side<NeutralItem>> => {
    const accountId = i.Type !== 'Inventory' ? i.IncomeAccountRef?.value : undefined
    const toLink = await toLinkFn(
      ctx,
      'qbo',
      accountId ? [{ entityType: 'account', id: accountId }] : []
    )
    const fields = qboToNeutral.item(i, toLink)
    if ('unsupported' in fields)
      return { state: 'unsupported', id: i.Id, reason: fields.unsupported }
    return live(i.Id, i.SyncToken, fields)
  },
}

const customer = {
  invoicing: (c: Customer): Side<NeutralCustomer> =>
    live(c.id, c.version, invoicingToNeutral.customer(c)),
  qbo: (c: QboCustomer): Side<NeutralCustomer> => live(c.Id, c.SyncToken, qboToNeutral.customer(c)),
}

export const accountSpec: EntitySpec<NeutralAccount> = {
  entityType: 'account',

  async read(ctx, system, id) {
    if (system === 'invoicing') {
      const a = await ctx.invoicing.getAccount(id)
      return a ? account.invoicing(a) : GONE
    }
    const a = await ctx.qbo.get('Account', id)
    return a ? account.qbo(a) : GONE
  },

  match: (ctx, system, fields) =>
    byName(
      system,
      fields.name,
      () => ctx.invoicing.listAccounts(),
      () => ctx.qbo.findByName('Account', fields.name)
    ),

  async create(ctx, system, fields, key) {
    return created(
      system === 'invoicing'
        ? account.invoicing(
            await ctx.invoicing.createAccount(neutralToInvoicing.account(fields), key)
          )
        : account.qbo(await ctx.qbo.create('Account', neutralToQbo.accountCreate(fields), key))
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
    return { version: versionOf(r) }
  },
}

export const itemSpec: EntitySpec<NeutralItem> = {
  entityType: 'item',

  async read(ctx, system, id) {
    if (system === 'invoicing') {
      const i = await ctx.invoicing.getItem(id)
      return i ? item.invoicing(ctx, i) : GONE
    }
    const i = await ctx.qbo.get('Item', id)
    return i ? item.qbo(ctx, i) : GONE
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
    return created(
      system === 'invoicing'
        ? await item.invoicing(
            ctx,
            await ctx.invoicing.createItem(neutralToInvoicing.item(fields, toSide), key)
          )
        : await item.qbo(
            ctx,
            await ctx.qbo.create('Item', neutralToQbo.itemCreate(fields, toSide), key)
          )
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
    return { version: versionOf(r) }
  },
}

export const customerSpec: EntitySpec<NeutralCustomer> = {
  entityType: 'customer',

  async read(ctx, system, id) {
    if (system === 'invoicing') {
      const c = await ctx.invoicing.getCustomer(id)
      return c ? customer.invoicing(c) : GONE
    }
    const c = await ctx.qbo.get('Customer', id)
    return c ? customer.qbo(c) : GONE
  },

  match: (ctx, system, fields) =>
    byName(
      system,
      fields.name,
      () => ctx.invoicing.listCustomers(),
      () => ctx.qbo.findByName('Customer', fields.name)
    ),

  async create(ctx, system, fields, key) {
    return created(
      system === 'invoicing'
        ? customer.invoicing(
            await ctx.invoicing.createCustomer(neutralToInvoicing.customer(fields), key)
          )
        : customer.qbo(await ctx.qbo.create('Customer', neutralToQbo.customerCreate(fields), key))
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
    return { version: versionOf(r) }
  },
}
