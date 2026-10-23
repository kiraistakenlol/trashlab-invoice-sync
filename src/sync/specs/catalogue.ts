// Entity specs for the catalogue: accounts, items and customers, matched by name.
import type { Account, Customer, Item } from '../../invoicing/types.js'
import type { QboAccount, QboCustomer, QboItem } from '../../qbo/entities.js'
import type { SyncContext } from '../context.js'
import type { EntitySpec } from '../engine.js'
import {
  fromInvoicingAccount,
  fromInvoicingCustomer,
  fromInvoicingItem,
  toInvoicingAccount,
  toInvoicingAccountPatch,
  toInvoicingCustomer,
  toInvoicingCustomerPatch,
  toInvoicingItem,
  toInvoicingItemPatch,
} from '../map-invoicing.js'
import {
  fromQboAccount,
  fromQboCustomer,
  fromQboItem,
  toQboAccount,
  toQboAccountPatch,
  toQboCustomer,
  toQboCustomerPatch,
  toQboItem,
  toQboItemPatch,
} from '../map-qbo.js'
import type { NeutralAccount, NeutralCustomer, NeutralItem, Side } from '../neutral.js'
import { toLinkFn, toSideFn } from '../refs.js'
import { expectLive, GONE, live, matchIds } from './side.js'

// invoicing compares names case-insensitively; QBO's name query already does
function idsNamed(records: { id: string; name: string }[], name: string): string[] {
  const lower = name.toLowerCase()
  return records.filter((r) => r.name.toLowerCase() === lower).map((r) => r.id)
}

const invoicingAccount = (a: Account): Side<NeutralAccount> =>
  live(a.id, a.version, fromInvoicingAccount(a))

// balance-sheet accounts change with every posting; only income accounts are synced
function qboAccount(a: QboAccount): Side<NeutralAccount> {
  if (a.AccountType !== 'Income') {
    return { state: 'ignored', id: a.Id, reason: 'not an income account' }
  }
  return live(a.Id, a.SyncToken, fromQboAccount(a))
}

async function invoicingItem(ctx: SyncContext, i: Item): Promise<Side<NeutralItem>> {
  const account = { entityType: 'account' as const, id: i.incomeAccountId }
  const toLink = await toLinkFn(ctx, 'invoicing', [account])
  return live(i.id, i.version, fromInvoicingItem(i, toLink))
}

async function qboItem(ctx: SyncContext, i: QboItem): Promise<Side<NeutralItem>> {
  const accountId = i.Type === 'Inventory' ? undefined : i.IncomeAccountRef?.value
  const accounts = accountId ? [{ entityType: 'account' as const, id: accountId }] : []
  const toLink = await toLinkFn(ctx, 'qbo', accounts)
  const fields = fromQboItem(i, toLink)
  if ('unsupported' in fields) {
    return { state: 'unsupported', id: i.Id, reason: fields.unsupported }
  }
  return live(i.Id, i.SyncToken, fields)
}

const invoicingCustomer = (c: Customer): Side<NeutralCustomer> =>
  live(c.id, c.version, fromInvoicingCustomer(c))

const qboCustomer = (c: QboCustomer): Side<NeutralCustomer> =>
  live(c.Id, c.SyncToken, fromQboCustomer(c))

export const accountSpec: EntitySpec<NeutralAccount> = {
  entityType: 'account',

  invoicing: {
    async read(ctx, id) {
      const a = await ctx.invoicing.getAccount(id)
      return a ? invoicingAccount(a) : GONE
    },
    async match(ctx, fields) {
      return matchIds(idsNamed(await ctx.invoicing.listAccounts(), fields.name))
    },
    async create(ctx, fields, key) {
      const a = await ctx.invoicing.createAccount(toInvoicingAccount(fields), key)
      return expectLive(invoicingAccount(a))
    },
    async update(ctx, side, changes) {
      const patch = toInvoicingAccountPatch(changes)
      const a = await ctx.invoicing.updateAccount(side.id, patch, Number(side.version))
      return String(a.version)
    },
  },

  qbo: {
    async read(ctx, id) {
      const a = await ctx.qbo.get('Account', id)
      return a ? qboAccount(a) : GONE
    },
    async match(ctx, fields) {
      return matchIds((await ctx.qbo.findByName('Account', fields.name)).map((a) => a.Id))
    },
    async create(ctx, fields, key) {
      return expectLive(qboAccount(await ctx.qbo.create('Account', toQboAccount(fields), key)))
    },
    async update(ctx, side, changes) {
      const body = { Id: side.id, SyncToken: side.version, ...toQboAccountPatch(changes) }
      return (await ctx.qbo.update('Account', body)).SyncToken
    },
  },
}

export const itemSpec: EntitySpec<NeutralItem> = {
  entityType: 'item',

  invoicing: {
    async read(ctx, id) {
      const i = await ctx.invoicing.getItem(id)
      return i ? invoicingItem(ctx, i) : GONE
    },
    async match(ctx, fields) {
      return matchIds(idsNamed(await ctx.invoicing.listItems(), fields.name))
    },
    async create(ctx, fields, key) {
      const toSide = await toSideFn(ctx, 'invoicing', [fields.incomeAccount])
      const i = await ctx.invoicing.createItem(toInvoicingItem(fields, toSide), key)
      return expectLive(await invoicingItem(ctx, i))
    },
    async update(ctx, side, changes) {
      const accounts = changes.incomeAccount === undefined ? [] : [changes.incomeAccount]
      const toSide = await toSideFn(ctx, 'invoicing', accounts)
      const patch = toInvoicingItemPatch(changes, toSide)
      const i = await ctx.invoicing.updateItem(side.id, patch, Number(side.version))
      return String(i.version)
    },
  },

  qbo: {
    async read(ctx, id) {
      const i = await ctx.qbo.get('Item', id)
      return i ? qboItem(ctx, i) : GONE
    },
    async match(ctx, fields) {
      return matchIds((await ctx.qbo.findByName('Item', fields.name)).map((i) => i.Id))
    },
    async create(ctx, fields, key) {
      const toSide = await toSideFn(ctx, 'qbo', [fields.incomeAccount])
      const i = await ctx.qbo.create('Item', toQboItem(fields, toSide), key)
      return expectLive(await qboItem(ctx, i))
    },
    async update(ctx, side, changes) {
      const accounts = changes.incomeAccount === undefined ? [] : [changes.incomeAccount]
      const toSide = await toSideFn(ctx, 'qbo', accounts)
      const body = { Id: side.id, SyncToken: side.version, ...toQboItemPatch(changes, toSide) }
      return (await ctx.qbo.update('Item', body)).SyncToken
    },
  },
}

export const customerSpec: EntitySpec<NeutralCustomer> = {
  entityType: 'customer',

  invoicing: {
    async read(ctx, id) {
      const c = await ctx.invoicing.getCustomer(id)
      return c ? invoicingCustomer(c) : GONE
    },
    async match(ctx, fields) {
      return matchIds(idsNamed(await ctx.invoicing.listCustomers(), fields.name))
    },
    async create(ctx, fields, key) {
      const c = await ctx.invoicing.createCustomer(toInvoicingCustomer(fields), key)
      return expectLive(invoicingCustomer(c))
    },
    async update(ctx, side, changes) {
      const patch = toInvoicingCustomerPatch(changes)
      const c = await ctx.invoicing.updateCustomer(side.id, patch, Number(side.version))
      return String(c.version)
    },
  },

  qbo: {
    async read(ctx, id) {
      const c = await ctx.qbo.get('Customer', id)
      return c ? qboCustomer(c) : GONE
    },
    async match(ctx, fields) {
      return matchIds((await ctx.qbo.findByName('Customer', fields.name)).map((c) => c.Id))
    },
    async create(ctx, fields, key) {
      return expectLive(qboCustomer(await ctx.qbo.create('Customer', toQboCustomer(fields), key)))
    },
    async update(ctx, side, changes) {
      const body = { Id: side.id, SyncToken: side.version, ...toQboCustomerPatch(changes) }
      return (await ctx.qbo.update('Customer', body)).SyncToken
    },
  },
}
