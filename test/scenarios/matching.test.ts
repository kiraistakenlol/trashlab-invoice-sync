// Existing records with no link (SCENARIOS.md L1-L5) and dependencies created along the way.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { QboEntities } from '../../src/qbo/api.js'
import { createWorld, type World } from '../harness/world.js'

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
