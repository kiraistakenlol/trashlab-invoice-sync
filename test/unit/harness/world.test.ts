import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { enqueue } from '../../../src/store/jobs.js'
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
    const invoice = await w.qboActor.createInvoice(customer.Id, [{ amount: '10.00' }])
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

  it('keeps record names as given', () => {
    expect(w.named('Acme')).toBe('Acme')
  })

  it('remembers what the QBO actor created', async () => {
    const customer = await w.qboActor.createCustomer('Remembered')
    const invoice = await w.qboActor.createInvoice(customer.Id, [{ amount: '5.00' }])
    expect(w.qboActor.created().slice(-2)).toEqual([
      { entity: 'Customer', id: customer.Id },
      { entity: 'Invoice', id: invoice.Id },
    ])
  })

  it('runs an invoicing hook after the named method', async () => {
    const seen: string[] = []
    w.hook('invoicing', 'listItems', async () => void seen.push('after'), 'after')
    await w.invoicing.listItems()
    expect(seen).toEqual([])
    await w.ctx.invoicing.listItems()
    expect(seen).toEqual(['after'])
  })
})

describe('world sync', () => {
  let sw: World
  beforeEach(async () => {
    sw = await createWorld()
  })
  afterEach(() => sw.close())

  it('keeps going while a job leaves new webhooks behind', async () => {
    const ran: string[] = []
    sw.run = async (job) => {
      ran.push(job.entityId)
      if (ran.length === 1) {
        await sw.qboActor.createCustomer('Echo')
      }
    }
    await sw.qboActor.createCustomer('First')
    await sw.sync()
    expect(ran).toHaveLength(2)
  })

  it('fails syncUntil naming what never became ready', async () => {
    await expect(sw.syncUntil(async () => false, 'the invoice')).rejects.toThrow('the invoice')
  })

  it('runs a pending job that has no webhook', async () => {
    const ran: string[] = []
    sw.run = async (job) => void ran.push(job.entityId)
    await enqueue(sw.db, { system: 'qbo', entityType: 'invoice', entityId: '7' }, sw.clock.now())
    await sw.sync()
    expect(ran).toEqual(['7'])
  })
})
