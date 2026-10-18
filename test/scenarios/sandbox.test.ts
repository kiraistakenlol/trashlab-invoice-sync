// Scenarios against the real QBO sandbox.
import { describe, expect, it } from 'vitest'
import { sandboxApi } from '../harness/sandbox.js'
import { createSandboxWorld } from '../harness/sandbox-world.js'
import { linkedCustomer } from './given.js'

describe('sandbox world', () => {
  it('creates an invoicing customer in QBO and cleans it up', async () => {
    const w = await createSandboxWorld()
    const { qboId } = await linkedCustomer(w, 'Acme')
    expect(await w.qboActor.get('Customer', qboId)).toMatchObject({
      DisplayName: w.named('Acme'),
      Active: true,
    })
    await w.close()
    expect(await sandboxApi().get('Customer', qboId)).toMatchObject({ Active: false })
  })

  it("sandbox world ignores the previous test's cleanup", async () => {
    // a world created right after the one above sees its cleanup through CDC
    const w = await createSandboxWorld()
    await w.sync()
    expect(await w.invoicing.listInvoices()).toEqual([])
    expect(await w.issues()).toEqual([])
    const customers = await w.invoicing.listCustomers()
    expect(customers.filter((c) => c.deactivatedAt === null)).toEqual([])
    await w.close()
  })
})
