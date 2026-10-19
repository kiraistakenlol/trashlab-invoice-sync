// Invoice creation on either side (SCENARIOS.md C3, C4, C5).
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EntityType } from '../../src/db/database.js'
import type { QboInvoice } from '../../src/qbo/entities.js'
import { createWorld, type World } from '../harness/world.js'
import { DUE_DATE, invoicingEvents, ISSUE_DATE, linkedCustomer, linkedItem } from './given.js'

let w: World
beforeEach(async () => {
  w = await createWorld()
})
afterEach(() => w.close())

const createdEntry = async (entityType: EntityType, qboId: string) => {
  const entries = (await w.history('qbo', entityType, qboId)).filter((e) => e.action === 'created')
  expect(entries).toHaveLength(1)
  expect(entries[0]!.error).toBeNull()
  return BigInt(entries[0]!.id)
}

describe('C3 a new invoice brings its customer along', () => {
  it('creates the customer in QBO before the invoice', async () => {
    // Given
    const customer = await w.invoicing.createCustomer({ name: 'Hauler Co' }, randomUUID())
    const { item } = await linkedItem(w, 'Pickup', 'Hauling')
    // When
    const invoice = await w.invoicing.createInvoice(
      {
        customerId: customer.id,
        issueDate: ISSUE_DATE,
        dueDate: DUE_DATE,
        lines: [{ itemId: item.id, quantity: '1', unitPrice: '75.00', amount: '75.00' }],
      },
      randomUUID()
    )
    await w.deliver({ drop: invoicingEvents('customer') })
    await w.sync()
    // Then
    const customerQboId = (await w.linkOf('customer', 'invoicing', customer.id))!.qboId!
    const qboId = (await w.linkOf('invoice', 'invoicing', invoice.id))!.qboId!
    expect(await w.qboActor.get('Customer', customerQboId)).toMatchObject({
      DisplayName: 'Hauler Co',
    })
    expect(await w.qboActor.get('Invoice', qboId)).toMatchObject({
      CustomerRef: { value: customerQboId },
    })
    expect(await createdEntry('customer', customerQboId)).toBeLessThan(
      await createdEntry('invoice', qboId)
    )
    expect(await w.issues()).toEqual([])
  })
})

describe('C4 a new invoice brings its item along', () => {
  it('creates the account and the item in QBO before the invoice', async () => {
    // Given
    const { customer } = await linkedCustomer(w, 'Acme')
    const account = await w.invoicing.createAccount({ name: 'Hauling' }, randomUUID())
    const item = await w.invoicing.createItem(
      { name: 'Pickup', incomeAccountId: account.id },
      randomUUID()
    )
    // When
    const invoice = await w.invoicing.createInvoice(
      {
        customerId: customer.id,
        issueDate: ISSUE_DATE,
        dueDate: DUE_DATE,
        lines: [{ itemId: item.id, quantity: '3', unitPrice: '10.00', amount: '30.00' }],
      },
      randomUUID()
    )
    await w.deliver({ drop: invoicingEvents('account', 'item') })
    await w.sync()
    // Then
    const accountQboId = (await w.linkOf('account', 'invoicing', account.id))!.qboId!
    const itemQboId = (await w.linkOf('item', 'invoicing', item.id))!.qboId!
    const qboId = (await w.linkOf('invoice', 'invoicing', invoice.id))!.qboId!
    expect(await w.qboActor.get('Item', itemQboId)).toMatchObject({
      Name: 'Pickup',
      IncomeAccountRef: { value: accountQboId },
    })
    expect(await w.qboActor.get('Invoice', qboId)).toMatchObject({
      Line: [
        {
          SalesItemLineDetail: {
            ItemRef: { value: itemQboId },
            ItemAccountRef: { value: accountQboId },
          },
        },
        { DetailType: 'SubTotalLineDetail' },
      ],
    })
    const order = [
      await createdEntry('account', accountQboId),
      await createdEntry('item', itemQboId),
      await createdEntry('invoice', qboId),
    ]
    expect([...order].sort((a, b) => (a < b ? -1 : 1))).toEqual(order)
    expect(await w.issues()).toEqual([])
  })
})

describe('C5 a QBO invoice invoicing cannot represent', () => {
  const textLine = {
    Amount: 0,
    Description: 'Thank you',
    DetailType: 'DescriptionOnly',
    DescriptionLineDetail: {},
  }
  const discountLine = {
    Amount: 10,
    DetailType: 'DiscountLineDetail',
    DiscountLineDetail: { PercentBased: false },
  }

  it.each([
    [
      'a foreign currency',
      (): Record<string, unknown> => ({ CurrencyRef: { value: 'EUR' } }),
      'currency EUR',
    ],
    [
      'a text-only line',
      (inv: QboInvoice) => ({ Line: [...inv.Line, textLine] }),
      'DescriptionOnly',
    ],
    [
      'a discount line',
      (inv: QboInvoice) => ({ Line: [...inv.Line, discountLine] }),
      'DiscountLineDetail',
    ],
  ] as const)('flags %s', async (_name, shape, reason) => {
    // Given
    const customer = await w.qboActor.createCustomer('Acme')
    const created = await w.qboActor.createInvoice(customer.Id, [{ amount: '100.00' }])
    const stored = (await w.qboActor.get('Invoice', created.Id))!
    w.qbo.rewrite(
      'Invoice',
      created.Id,
      shape({ ...stored, Line: stored.Line.filter((l) => l.DetailType !== 'SubTotalLineDetail') })
    )
    // When
    await w.sync()
    // Then
    expect(await w.issues()).toMatchObject([
      { kind: 'unsupported', details: { reason: expect.stringContaining(reason) } },
    ])
    expect(await w.invoicing.listInvoices()).toEqual([])
    expect(await w.linkOf('invoice', 'qbo', created.Id)).toBeNull()
  })

  it('flags an invoice of an inventory item', async () => {
    // Given
    const customer = await w.qboActor.createCustomer('Acme')
    const item = await w.qboActor.createItem('Container')
    w.qbo.rewrite('Item', item.Id, { Type: 'Inventory' })
    const created = await w.qboActor.createInvoice(customer.Id, [
      { amount: '100.00', itemId: item.Id },
    ])
    // When
    await w.sync()
    // Then
    expect(await w.issues()).toMatchObject([
      { kind: 'unsupported', details: { reason: expect.stringContaining('inventory') } },
    ])
    expect(await w.invoicing.listInvoices()).toEqual([])
    expect(await w.linkOf('invoice', 'qbo', created.Id)).toBeNull()
  })
})
