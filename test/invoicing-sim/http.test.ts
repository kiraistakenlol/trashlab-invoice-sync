// The sync's HTTP invoicing client against the in-memory invoicing system served over HTTP:
// both sides read the contract the same way.
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { InvoicingClient } from '../../src/invoicing/client.js'
import { InvoicingApiError } from '../../src/invoicing/errors.js'
import { createInvoicingClient } from '../../src/invoicing/http-client.js'
import type { InvoiceInput, InvoicingEvent } from '../../src/invoicing/types.js'
import { InMemoryInvoicing } from '../../invoicing-sim/invoicing.js'
import { buildInvoicingServer } from '../../invoicing-sim/server.js'

const TOKEN = 'sim-token'

let close: () => Promise<void>
let baseUrl: string
let client: InvoicingClient
let events: InvoicingEvent[]
let customerId: string
let itemId: string

const input = (over: Partial<InvoiceInput> = {}): InvoiceInput => ({
  customerId,
  issueDate: '2026-01-01',
  dueDate: '2026-01-31',
  lines: [{ itemId, quantity: '1', unitPrice: '100.00', amount: '100.00' }],
  ...over,
})

const rejection = async (p: Promise<unknown>): Promise<InvoicingApiError> => {
  const error = await p.then(
    () => null,
    (e: unknown) => e
  )
  expect(error).toBeInstanceOf(InvoicingApiError)
  return error as InvoicingApiError
}

beforeEach(async () => {
  events = []
  const app = buildInvoicingServer(new InMemoryInvoicing({ onEvent: (e) => events.push(e) }), TOKEN)
  await app.listen({ host: '127.0.0.1', port: 0 })
  close = () => app.close()
  baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  client = createInvoicingClient({ baseUrl, token: TOKEN })
  const account = await client.createAccount({ name: 'Sales' }, 'k-account')
  itemId = (await client.createItem({ name: 'Pickup', incomeAccountId: account.id }, 'k-item')).id
  customerId = (await client.createCustomer({ name: 'Acme' }, 'k-customer')).id
})

afterEach(() => close())

describe('invoicing over HTTP', () => {
  it('creates and reads an invoice; an unknown id is null', async () => {
    const invoice = await client.createInvoice(input({ memo: 'hello' }), 'k1')
    expect(await client.getInvoice(invoice.id)).toEqual(invoice)
    expect(await client.getInvoice('missing')).toBeNull()
  })

  it('replays a create with the same key and rejects a different body', async () => {
    const first = await client.createInvoice(input(), 'k1')
    expect(await client.createInvoice(input(), 'k1')).toEqual(first)
    const error = await rejection(client.createInvoice(input({ memo: 'other' }), 'k1'))
    expect(error).toMatchObject({ status: 409, code: 'idempotency_mismatch' })
    expect(await client.listInvoices()).toHaveLength(1)
  })

  it('writes with the version and rejects a stale one', async () => {
    const invoice = await client.createInvoice(input(), 'k1')
    const { number: _number, ...replace } = input({ memo: 'edited' })
    const edited = await client.replaceInvoice(invoice.id, replace, invoice.version)
    expect(edited).toMatchObject({ memo: 'edited', version: invoice.version + 1 })
    const error = await rejection(client.replaceInvoice(invoice.id, replace, invoice.version))
    expect(error).toMatchObject({ status: 409, code: 'version_conflict' })
  })

  it('voids and deletes with the version; a deleted record still reads', async () => {
    const a = await client.createInvoice(input(), 'k1')
    expect(await client.voidInvoice(a.id, a.version)).toMatchObject({ status: 'void' })
    const b = await client.createInvoice(input(), 'k2')
    await client.deleteInvoice(b.id, b.version)
    expect(await client.getInvoice(b.id)).toMatchObject({ deletedAt: expect.any(String) })
  })

  it('records a payment and filters lists', async () => {
    const invoice = await client.createInvoice(input({ number: 'A-1' }), 'k1')
    await client.createInvoice(input({ number: 'B-2' }), 'k2')
    const payment = await client.createPayment(
      {
        customerId,
        amount: '40.00',
        date: '2026-01-05',
        allocations: [{ invoiceId: invoice.id, amount: '40.00' }],
      },
      'k-pay'
    )
    expect(await client.listPayments({ customerId })).toEqual([payment])
    expect((await client.listInvoices({ number: 'A-1' })).map((i) => i.id)).toEqual([invoice.id])
    expect(await client.getInvoice(invoice.id)).toMatchObject({ paid: '40.00', balance: '60.00' })
  })

  it('reports a rule violation as a permanent rejection', async () => {
    const error = await rejection(client.createInvoice(input({ customerId: 'missing' }), 'k1'))
    expect(error.status).toBe(422)
  })

  it('serves every change on the events feed and to onEvent, in order', async () => {
    const invoice = await client.createInvoice(input(), 'k1')
    const feed = await client.listEvents(null)
    expect(feed).toEqual(events)
    expect(feed.at(-1)).toMatchObject({
      entityType: 'invoice',
      entityId: invoice.id,
      kind: 'created',
      version: 1,
    })
    expect(await client.listEvents(feed.at(-2)!.id)).toEqual([feed.at(-1)])
  })

  it('refuses a request without the token', async () => {
    const stranger = createInvoicingClient({ baseUrl, token: 'wrong' })
    const error = await rejection(stranger.listInvoices())
    expect(error.status).toBe(422)
    expect(error.message).toBe('Bearer token required')
  })
})
