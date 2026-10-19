// Accounts, items and customers sync without any invoice (SCENARIOS.md G1).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EntityType } from '../../src/db/database.js'
import { QboApi } from '../../src/qbo/api.js'
import { createWorld, type World } from '../harness/world.js'

let w: World
let qbo: QboApi
beforeEach(async () => {
  w = await createWorld()
  qbo = new QboApi(w.qbo)
})
afterEach(() => w.close())

type Kind = Extract<EntityType, 'account' | 'item' | 'customer'>
type QboKind = 'Account' | 'Item' | 'Customer'

interface Adapter {
  qboKind: QboKind
  nameField: 'Name' | 'DisplayName'
  // new records in invoicing, and in QBO, returning the id
  createInvoicing(name: string): Promise<string>
  createQbo(name: string): Promise<string>
  rename(id: string, name: string): Promise<void>
  deactivate(id: string): Promise<void>
  read(id: string): Promise<{ name: string; active: boolean }>
}

const SERVICES_ACCOUNT = '1'

const adapters: Record<Kind, Adapter> = {
  account: {
    qboKind: 'Account',
    nameField: 'Name',
    createInvoicing: async (name) => (await w.invoicing.createAccount({ name }, `k-${name}`)).id,
    createQbo: async (name) =>
      (await qbo.create('Account', { Name: name, AccountType: 'Income' }, `k-${name}`)).Id,
    rename: async (id, name) => {
      const a = (await w.invoicing.getAccount(id))!
      await w.invoicing.updateAccount(id, { name }, a.version)
    },
    deactivate: async (id) => {
      const a = (await w.invoicing.getAccount(id))!
      await w.invoicing.updateAccount(id, { deactivated: true }, a.version)
    },
    read: async (id) => {
      const a = (await w.invoicing.getAccount(id))!
      return { name: a.name, active: a.deactivatedAt === null }
    },
  },
  item: {
    qboKind: 'Item',
    nameField: 'Name',
    createInvoicing: async (name) => {
      const account = await w.invoicing.createAccount({ name: `${name} income` }, `k-a-${name}`)
      return (await w.invoicing.createItem({ name, incomeAccountId: account.id }, `k-${name}`)).id
    },
    createQbo: async (name) =>
      (
        await qbo.create(
          'Item',
          { Name: name, Type: 'Service', IncomeAccountRef: { value: SERVICES_ACCOUNT } },
          `k-${name}`
        )
      ).Id,
    rename: async (id, name) => {
      const i = (await w.invoicing.getItem(id))!
      await w.invoicing.updateItem(id, { name }, i.version)
    },
    deactivate: async (id) => {
      const i = (await w.invoicing.getItem(id))!
      await w.invoicing.updateItem(id, { deactivated: true }, i.version)
    },
    read: async (id) => {
      const i = (await w.invoicing.getItem(id))!
      return { name: i.name, active: i.deactivatedAt === null }
    },
  },
  customer: {
    qboKind: 'Customer',
    nameField: 'DisplayName',
    createInvoicing: async (name) => (await w.invoicing.createCustomer({ name }, `k-${name}`)).id,
    createQbo: async (name) =>
      (await qbo.create('Customer', { DisplayName: name }, `k-${name}`)).Id,
    rename: async (id, name) => {
      const c = (await w.invoicing.getCustomer(id))!
      await w.invoicing.updateCustomer(id, { name }, c.version)
    },
    deactivate: async (id) => {
      const c = (await w.invoicing.getCustomer(id))!
      await w.invoicing.updateCustomer(id, { deactivated: true }, c.version)
    },
    read: async (id) => {
      const c = (await w.invoicing.getCustomer(id))!
      return { name: c.name, active: c.deactivatedAt === null }
    },
  },
}

const kinds: Kind[] = ['account', 'item', 'customer']

// the QBO record as { name, active }
const qboState = async (kind: Kind, id: string) => {
  const a = adapters[kind]
  const r = (await qbo.get(a.qboKind, id))! as unknown as Record<string, unknown> & {
    Active: boolean
  }
  return { name: r[a.nameField] as string, active: r.Active }
}

const qboUpdate = async (kind: Kind, id: string, patch: Record<string, unknown>) => {
  const current = (await qbo.get(adapters[kind].qboKind, id))!
  await qbo.update(adapters[kind].qboKind, { ...patch, Id: id, SyncToken: current.SyncToken })
}

const noInvoices = async () => {
  expect(await w.invoicing.listInvoices()).toEqual([])
  expect(await w.issues()).toEqual([])
}

describe.each(kinds)('G1 a %s syncs on its own', (kind) => {
  const a = () => adapters[kind]

  it('created in invoicing is created in QBO', async () => {
    // Given / When
    const id = await a().createInvoicing('Gadget')
    await w.sync()
    // Then
    const qboId = (await w.linkOf(kind, 'invoicing', id))!.qboId!
    expect(await qboState(kind, qboId)).toEqual({ name: 'Gadget', active: true })
    await noInvoices()
  })

  it('created in QBO is created in invoicing', async () => {
    // Given / When
    const qboId = await a().createQbo('Gadget')
    await w.sync()
    // Then
    const id = (await w.linkOf(kind, 'qbo', qboId))!.invoicingId!
    expect(await a().read(id)).toEqual({ name: 'Gadget', active: true })
    await noInvoices()
  })

  it('renamed in invoicing is renamed in QBO', async () => {
    // Given
    const id = await a().createInvoicing('Gadget')
    await w.sync()
    // When
    await a().rename(id, 'Widget')
    await w.sync()
    // Then
    const qboId = (await w.linkOf(kind, 'invoicing', id))!.qboId!
    expect(await qboState(kind, qboId)).toEqual({ name: 'Widget', active: true })
    await noInvoices()
  })

  it('renamed in QBO is renamed in invoicing', async () => {
    // Given
    const qboId = await a().createQbo('Gadget')
    await w.sync()
    // When
    await qboUpdate(kind, qboId, { [a().nameField]: 'Widget' })
    await w.sync()
    // Then
    const id = (await w.linkOf(kind, 'qbo', qboId))!.invoicingId!
    expect(await a().read(id)).toEqual({ name: 'Widget', active: true })
    await noInvoices()
  })

  it('deactivated in invoicing is deactivated in QBO', async () => {
    // Given
    const id = await a().createInvoicing('Gadget')
    await w.sync()
    // When
    await a().deactivate(id)
    await w.sync()
    // Then
    const qboId = (await w.linkOf(kind, 'invoicing', id))!.qboId!
    expect(await qboState(kind, qboId)).toMatchObject({ active: false })
    await noInvoices()
  })

  it('deactivated in QBO is deactivated in invoicing', async () => {
    // Given
    const qboId = await a().createQbo('Gadget')
    await w.sync()
    // When
    await qboUpdate(kind, qboId, { Active: false })
    await w.sync()
    // Then
    const id = (await w.linkOf(kind, 'qbo', qboId))!.invoicingId!
    expect(await a().read(id)).toEqual({ name: 'Gadget', active: false })
    expect(await qboState(kind, qboId)).toEqual({ name: 'Gadget (deleted)', active: false })
    await noInvoices()
  })
})
