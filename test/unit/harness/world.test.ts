import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createWorld, type World } from '../../harness/world.js'

let w: World
beforeAll(async () => {
  w = await createWorld({ config: { maxAttempts: 1 } })
})
afterAll(() => w.close())

describe('world', () => {
  it('merges config overrides over the defaults', () => {
    expect(w.ctx.config).toMatchObject({ maxAttempts: 1, leaseMs: 60_000 })
  })

  it('delivers QBO edits made by the actor as signed webhooks', async () => {
    const customer = await w.qboActor.createCustomer('Hook Customer')
    const invoice = await w.qboActor.createInvoice(customer.Id, [{ amount: 10 }])
    await w.deliver()
    expect(await w.history('qbo', 'invoice', invoice.Id)).toHaveLength(1)
    expect(await w.history('qbo', 'customer', customer.Id)).toHaveLength(1)
  })

  it('runs a QBO hook once, around the sync call only', async () => {
    const customer = await w.qboActor.createCustomer('Hooked')
    const seen: string[] = []
    w.hook(
      'qbo',
      { method: 'GET', path: '/customer' },
      async () => void seen.push('before'),
      'before'
    )
    await w.qboActor.get('Customer', customer.Id)
    expect(seen).toEqual([])
    await w.ctx.qbo.get('Customer', customer.Id)
    await w.ctx.qbo.get('Customer', customer.Id)
    expect(seen).toEqual(['before'])
  })

  it('runs an invoicing hook after the named method', async () => {
    const seen: string[] = []
    w.hook('invoicing', 'listItems', async () => void seen.push('after'), 'after')
    await w.invoicing.listItems()
    expect(seen).toEqual([])
    await w.ctx.invoicing.listItems()
    expect(seen).toEqual(['after'])
  })

  it('throws until the worker is wired', async () => {
    await expect(w.drain()).rejects.toThrow('not implemented')
  })
})
