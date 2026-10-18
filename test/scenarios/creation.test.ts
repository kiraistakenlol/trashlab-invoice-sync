// Invoice creation on either side (SCENARIOS.md C3, C4).
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EntityType } from '../../src/db/database.js'
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
