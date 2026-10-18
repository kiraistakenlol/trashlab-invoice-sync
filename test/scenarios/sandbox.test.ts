// Scenarios against the real QBO sandbox.
import { describe, expect, it } from 'vitest'
import { generalLedger, postingAccountIds } from '../harness/gl-report.js'
import { sandboxApi, sandboxClient } from '../harness/sandbox.js'
import { createSandboxWorld } from '../harness/sandbox-world.js'
import { ISSUE_DATE, linkedInvoice, linkedItem, linkedPayment, linkedCustomer } from './given.js'
import { starScenarios } from './star.js'

describe('sandbox world', () => {
  it('creates an invoicing customer in QBO and cleans it up', async () => {
    const w = await createSandboxWorld()
    let qboId: string
    try {
      ;({ qboId } = await linkedCustomer(w, 'Acme'))
      expect(await w.qboActor.get('Customer', qboId)).toMatchObject({
        DisplayName: w.named('Acme'),
        Active: true,
      })
    } finally {
      await w.close()
    }
    expect(await sandboxApi().get('Customer', qboId)).toMatchObject({ Active: false })
  })

  it("sandbox world ignores the previous test's cleanup", async () => {
    // a world created right after the one above sees its cleanup through CDC
    const w = await createSandboxWorld()
    try {
      await w.sync()
      expect(await w.invoicing.listInvoices()).toEqual([])
      expect(await w.issues()).toEqual([])
      const customers = await w.invoicing.listCustomers()
      expect(customers.filter((c) => c.deactivatedAt === null)).toEqual([])
    } finally {
      await w.close()
    }
  })
})

starScenarios(() => createSandboxWorld())

describe('sandbox postings', () => {
  it('G2 GL postings land on the mapped accounts', async () => {
    const w = await createSandboxWorld()
    try {
      const { customer } = await linkedCustomer(w, 'Acme')
      const { item, qboId: itemQboId } = await linkedItem(w, 'Pickup', 'Hauling')
      const { invoice } = await linkedInvoice(w, {
        customer,
        lines: [{ itemId: item.id, quantity: '1', unitPrice: '123.45', amount: '123.45' }],
      })
      await linkedPayment(w, invoice, '23.45')

      const client = sandboxClient()
      const income = (await sandboxApi().get('Item', itemQboId))!.IncomeAccountRef!.value
      const { receivable, undeposited } = await postingAccountIds(client)
      const rows = await generalLedger(client, {
        date: ISSUE_DATE,
        accountIds: [income, receivable, undeposited],
      })

      const postings = (r: { type: string; num: string; name: string }) =>
        r.type === 'Invoice' ? r.num === invoice.number : r.name.startsWith(w.named(''))
      const posted = rows
        .filter(postings)
        .map((r) => ({ type: r.type, accountId: r.accountId, amount: r.amount }))
      expect(posted).toEqual(
        expect.arrayContaining([
          { type: 'Invoice', accountId: income, amount: '123.45' },
          { type: 'Invoice', accountId: receivable, amount: '123.45' },
          { type: 'Payment', accountId: receivable, amount: '-23.45' },
          { type: 'Payment', accountId: undeposited, amount: '23.45' },
        ])
      )
    } finally {
      await w.close()
    }
  })
})
