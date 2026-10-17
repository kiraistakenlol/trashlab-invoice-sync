// Behaviour of the in-memory invoicing system.
import { beforeEach, describe, expect, it } from 'vitest'
import { InvoicingApiError } from '../../src/invoicing/errors.js'
import type { InvoiceInput } from '../../src/invoicing/types.js'
import { FakeInvoicing } from './fake-invoicing.js'

const rejection = async (p: Promise<unknown>): Promise<InvoicingApiError> => {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(InvoicingApiError)
    return e as InvoicingApiError
  }
  throw new Error('expected a rejection')
}

describe('FakeInvoicing invoices and catalogue', () => {
  let fake: FakeInvoicing
  let customerId: string
  let itemId: string

  const input = (over: Partial<InvoiceInput> = {}): InvoiceInput => ({
    customerId,
    issueDate: '2026-01-01',
    dueDate: '2026-01-31',
    lines: [{ itemId, quantity: '1', unitPrice: '100.00', amount: '100.00' }],
    ...over,
  })

  beforeEach(async () => {
    fake = new FakeInvoicing({ now: () => new Date('2026-01-01T00:00:00.000Z') })
    const account = await fake.createAccount({ name: 'Sales' }, 'k-acc')
    itemId = (await fake.createItem({ name: 'Pickup', incomeAccountId: account.id }, 'k-item')).id
    customerId = (await fake.createCustomer({ name: 'Acme' }, 'k-cust')).id
  })

  it('generates invoice numbers', async () => {
    const a = await fake.createInvoice(input(), 'k1')
    const b = await fake.createInvoice(input(), 'k2')
    expect([a.number, b.number]).toEqual(['INV-0001', 'INV-0002'])
  })

  it('rejects a duplicate number ignoring case', async () => {
    await fake.createInvoice(input({ number: 'inv-9' }), 'k1')
    const err = await rejection(fake.createInvoice(input({ number: 'INV-9' }), 'k2'))
    expect(err.code).toBe('number_taken')
    expect(err.status).toBe(409)
  })

  it('rejects a number over 21 characters', async () => {
    const err = await rejection(fake.createInvoice(input({ number: 'X'.repeat(22) }), 'k1'))
    expect(err.code).toBe('rule_violation')
  })

  it('rejects a line whose amount is not quantity x unit price', async () => {
    const lines = [{ itemId, quantity: '2', unitPrice: '10.00', amount: '25.00' }]
    const err = await rejection(fake.createInvoice(input({ lines }), 'k1'))
    expect(err.code).toBe('rule_violation')
    expect(err.status).toBe(422)
  })

  it('derives total from lines plus tax', async () => {
    const lines = [
      { itemId, quantity: '1', unitPrice: '100.00', amount: '100.00' },
      { itemId, quantity: '3', unitPrice: '10.00', amount: '30.00' },
    ]
    const inv = await fake.createInvoice(input({ lines, tax: '1.20' }), 'k1')
    expect(inv).toMatchObject({
      total: '131.20',
      paid: '0.00',
      balance: '131.20',
      status: 'open',
      version: 1,
    })
  })

  it('keeps line ids across a replace', async () => {
    const lines = [
      { itemId, quantity: '1', unitPrice: '100.00', amount: '100.00' },
      { itemId, quantity: '1', unitPrice: '30.00', amount: '30.00' },
    ]
    const inv = await fake.createInvoice(input({ lines }), 'k1')
    const [l1] = inv.lines
    const replaced = await fake.replaceInvoice(
      inv.id,
      {
        customerId,
        issueDate: '2026-01-01',
        dueDate: '2026-01-31',
        lines: [
          { id: l1!.id, itemId, quantity: '2', unitPrice: '100.00', amount: '200.00' },
          { itemId, quantity: '1', unitPrice: '5.00', amount: '5.00' },
        ],
      },
      1
    )
    expect(replaced.lines[0]!.id).toBe(l1!.id)
    expect(replaced.lines).toHaveLength(2)
    expect(replaced.lines[1]!.id).not.toBe(inv.lines[1]!.id)
    expect(replaced.total).toBe('205.00')
    expect(replaced.version).toBe(2)
  })

  it('rejects a stale version', async () => {
    const inv = await fake.createInvoice(input(), 'k1')
    await fake.replaceInvoice(inv.id, input(), 1)
    const err = await rejection(fake.replaceInvoice(inv.id, input(), 1))
    expect(err.code).toBe('version_conflict')
    expect(err.status).toBe(409)
  })

  it('void is final', async () => {
    const inv = await fake.createInvoice(input(), 'k1')
    const voided = await fake.voidInvoice(inv.id, 1)
    expect(voided.status).toBe('void')
    expect(voided.voidedAt).not.toBeNull()
    expect((await rejection(fake.replaceInvoice(inv.id, input(), 2))).status).toBe(422)
    expect((await rejection(fake.voidInvoice(inv.id, 2))).status).toBe(422)
  })

  it('deletes a void invoice', async () => {
    const inv = await fake.createInvoice(input(), 'k1')
    await fake.voidInvoice(inv.id, 1)
    const deleted = await fake.deleteInvoice(inv.id, 2)
    expect(deleted.status).toBe('deleted')
    expect(deleted.voidedAt).not.toBeNull()
  })

  it('rejects a malformed amount', async () => {
    const bad = (over: Partial<InvoiceInput['lines'][number]>) => [
      { itemId, quantity: '1', unitPrice: '100.00', amount: '100.00', ...over },
    ]
    for (const lines of [
      bad({ unitPrice: 'abc' }),
      bad({ unitPrice: '100.0', amount: '100.0' }),
      bad({ quantity: 'x' }),
      bad({ quantity: '0', amount: '0.00' }),
    ]) {
      expect((await rejection(fake.createInvoice(input({ lines }), 'kb'))).code).toBe(
        'rule_violation'
      )
    }
    expect((await rejection(fake.createInvoice(input({ tax: '1.5' }), 'kt'))).status).toBe(422)
  })

  it('delete is soft', async () => {
    const inv = await fake.createInvoice(input(), 'k1')
    await fake.deleteInvoice(inv.id, 1)
    const got = await fake.getInvoice(inv.id)
    expect(got?.status).toBe('deleted')
    expect(got?.deletedAt).not.toBeNull()
    expect((await rejection(fake.replaceInvoice(inv.id, input(), 2))).status).toBe(422)
  })

  it('replays a create with the same idempotency key', async () => {
    const a = await fake.createInvoice(input(), 'same')
    const b = await fake.createInvoice(input(), 'same')
    expect(b).toEqual(a)
    expect(b).not.toBe(a)
    expect(await fake.listInvoices()).toHaveLength(1)
  })

  it('rejects the same key with a different body', async () => {
    await fake.createInvoice(input(), 'same')
    const err = await rejection(fake.createInvoice(input({ memo: 'other' }), 'same'))
    expect(err.code).toBe('idempotency_mismatch')
    expect(err.status).toBe(409)
  })

  it('filters by number ignoring case', async () => {
    await fake.createInvoice(input({ number: 'INV-7' }), 'k1')
    await fake.createInvoice(input({ number: 'INV-8' }), 'k2')
    const found = await fake.listInvoices({ number: 'inv-7' })
    expect(found.map((i) => i.number)).toEqual(['INV-7'])
  })

  it('rejects a duplicate customer name ignoring case', async () => {
    const err = await rejection(fake.createCustomer({ name: 'ACME' }, 'k-other'))
    expect(err.code).toBe('rule_violation')
    expect(err.status).toBe(422)
  })

  it('deactivates a customer', async () => {
    const updated = await fake.updateCustomer(customerId, { deactivated: true }, 1)
    expect(updated.deactivatedAt).not.toBeNull()
    expect(updated.version).toBe(2)
  })

  it('returns copies', async () => {
    const inv = await fake.createInvoice(input(), 'k1')
    inv.lines[0]!.amount = '999.00'
    expect((await fake.getInvoice(inv.id))?.lines[0]?.amount).toBe('100.00')
  })
})
