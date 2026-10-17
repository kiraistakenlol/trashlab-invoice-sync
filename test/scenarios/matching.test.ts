// Existing records with no link (SCENARIOS.md L1-L5) and dependencies created along the way.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { QboEntities } from '../../src/qbo/api.js'
import { createWorld, type World } from '../harness/world.js'
import { DUE_DATE, ISSUE_DATE, linkedCustomer, linkedItem } from './given.js'

let w: World
beforeEach(async () => {
  w = await createWorld()
})
afterEach(() => w.close())

const qboCount = async (entity: keyof QboEntities) => {
  const res = await w.qbo.query(`select * from ${entity}`)
  return ((res.body as { QueryResponse: Record<string, unknown[]> }).QueryResponse[entity] ?? [])
    .length
}

describe('L4 customers and items are matched by name', () => {
  it('links same-named records instead of creating new ones', async () => {
    // Given
    const account = await w.invoicing.createAccount({ name: 'Services' }, 'k-account')
    const item = await w.invoicing.createItem(
      { name: 'Services', incomeAccountId: account.id },
      'k-item'
    )
    const customer = await w.invoicing.createCustomer({ name: 'Acme' }, 'k-customer')
    const qboCustomer = await w.qboActor.createCustomer('ACME')
    const before = { customers: await qboCount('Customer'), items: await qboCount('Item') }
    // When
    await w.sync()
    // Then
    expect(await w.linkOf('account', 'invoicing', account.id)).toMatchObject({ qboId: '1' })
    expect(await w.linkOf('item', 'invoicing', item.id)).toMatchObject({ qboId: '1' })
    const link = await w.linkOf('customer', 'invoicing', customer.id)
    expect(link).toMatchObject({ qboId: qboCustomer.Id })
    expect({ customers: await qboCount('Customer'), items: await qboCount('Item') }).toEqual(before)
    expect(await w.invoicing.listCustomers()).toHaveLength(1)
    expect(await w.invoicing.listItems()).toHaveLength(1)
    expect(await w.invoicing.listAccounts()).toHaveLength(1)
    const histories = [
      ...(await w.history('invoicing', 'customer', customer.id)),
      ...(await w.history('qbo', 'customer', qboCustomer.Id)),
    ]
    expect(histories.filter((e) => e.action === 'linked')).toHaveLength(1)
    // the names differ in case and have no common past, which is flagged, not guessed
    expect(await w.issues()).toMatchObject([
      {
        kind: 'conflict',
        linkId: link!.id,
        details: { conflicts: [{ field: 'name', invoicing: 'Acme', qbo: 'ACME' }] },
      },
    ])
  })
})

describe('C4 an item brings its income account along', () => {
  it('creates the income account in QBO before the item', async () => {
    // Given
    const account = await w.invoicing.createAccount({ name: 'Hauling' }, 'k-account')
    const item = await w.invoicing.createItem(
      { name: 'Pickup', incomeAccountId: account.id },
      'k-item'
    )
    // When
    await w.sync()
    // Then
    const accountId = (await w.linkOf('account', 'invoicing', account.id))!.qboId!
    const itemId = (await w.linkOf('item', 'invoicing', item.id))!.qboId!
    expect(await w.qboActor.get('Account', accountId)).toMatchObject({
      Name: 'Hauling',
      AccountType: 'Income',
    })
    expect(await w.qboActor.get('Item', itemId)).toMatchObject({
      Name: 'Pickup',
      IncomeAccountRef: { value: accountId },
    })
    const createdAt = async (entityType: 'account' | 'item', id: string) =>
      BigInt((await w.history('qbo', entityType, id)).find((e) => e.action === 'created')!.id)
    expect(await createdAt('account', accountId)).toBeLessThan(await createdAt('item', itemId))
    expect(await w.issues()).toEqual([])
  })
})

// The same invoice entered on both sides by hand: number A-100, one 100.00 line.
async function enteredOnBothSides(qbo: { customerName?: string; amount?: string } = {}) {
  const { customer, qboId: customerQboId } = await linkedCustomer(w, 'Acme')
  const { item, qboId: itemQboId } = await linkedItem(w, 'Pickup', 'Hauling')
  const invoice = await w.invoicing.createInvoice(
    {
      number: 'A-100',
      customerId: customer.id,
      issueDate: ISSUE_DATE,
      dueDate: DUE_DATE,
      lines: [{ itemId: item.id, quantity: '1', unitPrice: '100.00', amount: '100.00' }],
    },
    'k-invoice'
  )
  const qboCustomerId = qbo.customerName
    ? (await w.qboActor.createCustomer(qbo.customerName)).Id
    : customerQboId
  const qboInvoice = await w.qboActor.createInvoice(
    qboCustomerId,
    [{ amount: qbo.amount ?? '100.00', itemId: itemQboId }],
    { DocNumber: 'A-100', TxnDate: ISSUE_DATE, DueDate: DUE_DATE }
  )
  return { invoice, qboInvoice }
}

const invoiceCounts = async () => ({
  invoicing: (await w.invoicing.listInvoices()).length,
  qbo: await qboCount('Invoice'),
})

describe('L1 same invoice exists on both sides', () => {
  it('links the two invoices and creates nothing', async () => {
    // Given
    const { invoice, qboInvoice } = await enteredOnBothSides()
    // When
    await w.sync()
    // Then
    expect(await w.linkOf('invoice', 'invoicing', invoice.id)).toMatchObject({
      qboId: qboInvoice.Id,
    })
    expect(await invoiceCounts()).toEqual({ invoicing: 1, qbo: 1 })
    const histories = [
      ...(await w.history('invoicing', 'invoice', invoice.id)),
      ...(await w.history('qbo', 'invoice', qboInvoice.Id)),
    ]
    expect(histories.filter((e) => e.action === 'linked')).toHaveLength(1)
    expect(histories.filter((e) => e.action === 'created')).toEqual([])
    expect(await w.issues()).toEqual([])
  })
})

describe('L2 same number, different invoice', () => {
  it.each([
    ['total', { amount: '90.00' }],
    ['customer', { customerName: 'Other Co' }],
  ])('flags the number as taken when the %s differs', async (_field, qbo) => {
    // Given
    const { invoice, qboInvoice } = await enteredOnBothSides(qbo)
    // When
    await w.sync()
    // Then
    expect(await w.linkOf('invoice', 'invoicing', invoice.id)).toBeNull()
    expect(await w.linkOf('invoice', 'qbo', qboInvoice.Id)).toBeNull()
    expect(await invoiceCounts()).toEqual({ invoicing: 1, qbo: 1 })
    const issues = await w.issues()
    expect(issues.map((i) => [i.kind, i.ref.system, i.ref.entityId])).toEqual(
      expect.arrayContaining([
        ['number_taken', 'invoicing', invoice.id],
        ['number_taken', 'qbo', qboInvoice.Id],
      ])
    )
    expect(issues).toHaveLength(2)
    for (const [system, id] of [
      ['invoicing', invoice.id],
      ['qbo', qboInvoice.Id],
    ] as const) {
      const actions = (await w.history(system, 'invoice', id)).map((e) => e.action)
      expect(actions).toContain('issue_opened')
      expect(actions).not.toContain('created')
    }
  })
})
