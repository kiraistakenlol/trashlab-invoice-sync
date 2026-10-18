import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { InvoicingApiError } from '../../../src/invoicing/errors.js'
import { createInvoicingClient } from '../../../src/invoicing/http-client.js'

interface Recorded {
  method: string
  url: string
  headers: IncomingMessage['headers']
  body: unknown
}

type Reply = (res: ServerResponse) => void

let server: Server
let baseUrl: string
let requests: Recorded[]
let reply: Reply

const json =
  (status: number, body: unknown): Reply =>
  (res) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }

beforeEach(async () => {
  requests = []
  reply = json(200, { data: null })
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString()
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: raw ? JSON.parse(raw) : undefined,
      })
      reply(res)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  server.closeAllConnections()
  await new Promise((r) => server.close(r))
})

const client = (timeoutMs?: number) => createInvoicingClient({ baseUrl, token: 't', timeoutMs })

describe('createInvoicingClient', () => {
  it('creates an invoice with the idempotency key and bearer token', async () => {
    reply = json(201, { data: { id: 'i1' } })
    const input = { customerId: 'c', issueDate: 'a', dueDate: 'b', lines: [] }
    const invoice = await client().createInvoice(input, 'key-1')
    expect(invoice).toEqual({ id: 'i1' })
    expect(requests[0]).toMatchObject({ method: 'POST', url: '/invoices', body: input })
    expect(requests[0].headers['idempotency-key']).toBe('key-1')
    expect(requests[0].headers.authorization).toBe('Bearer t')
  })

  it('sends the version in the body of a replace', async () => {
    reply = json(200, { data: { id: 'i1' } })
    const input = { customerId: 'c', issueDate: 'a', dueDate: 'b', lines: [] }
    await client().replaceInvoice('i1', input, 3)
    expect(requests[0]).toMatchObject({ method: 'PUT', url: '/invoices/i1' })
    expect(requests[0].body).toEqual({ ...input, version: 3 })
  })

  it('sends the version in the body of a void and a catalogue patch', async () => {
    reply = json(200, { data: {} })
    await client().voidInvoice('i1', 2)
    await client().updateCustomer('c1', { name: 'N', deactivated: true }, 4)
    expect(requests[0]).toMatchObject({ method: 'POST', url: '/invoices/i1/void' })
    expect(requests[0].body).toEqual({ version: 2 })
    expect(requests[1]).toMatchObject({ method: 'PATCH', url: '/customers/c1' })
    expect(requests[1].body).toEqual({ name: 'N', deactivated: true, version: 4 })
  })

  it('sends the version in the query of a delete', async () => {
    reply = json(200, { data: {} })
    await client().deleteInvoice('i1', 3)
    await client().deletePayment('p1', 5)
    expect(requests.map((r) => [r.method, r.url])).toEqual([
      ['DELETE', '/invoices/i1?version=3'],
      ['DELETE', '/payments/p1?version=5'],
    ])
  })

  it('returns null when a read by id is 404', async () => {
    reply = json(404, { error: { code: 'not_found', message: 'no such invoice' } })
    expect(await client().getInvoice('x')).toBeNull()
    expect(await client().getPayment('x')).toBeNull()
  })

  it('passes list filters and the event cursor as query parameters', async () => {
    reply = json(200, { data: [] })
    await client().listInvoices({ customerId: 'c 1', number: 'A-1' })
    await client().listPayments({ customerId: 'c1' })
    await client().listEvents('e5', 50)
    await client().listEvents(null)
    expect(requests.map((r) => r.url)).toEqual([
      '/invoices?customerId=c+1&number=A-1',
      '/payments?customerId=c1',
      '/events?after=e5&limit=50',
      '/events',
    ])
  })

  it('throws InvoicingApiError from the error envelope', async () => {
    reply = json(409, { error: { code: 'version_conflict', message: 'stale' } })
    const error = await client()
      .replaceInvoice('i1', { customerId: 'c', issueDate: 'a', dueDate: 'b', lines: [] }, 1)
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(InvoicingApiError)
    expect(error).toMatchObject({ status: 409, code: 'version_conflict', message: 'stale' })
  })

  it('maps a non-envelope server failure to a transient 503', async () => {
    reply = (res) => {
      res.writeHead(502)
      res.end('bad gateway')
    }
    await expect(client().listAccounts()).rejects.toMatchObject({
      status: 503,
      code: 'unavailable',
    })
  })

  it('maps another client error to a permanent 422', async () => {
    reply = json(401, { error: { code: 'unauthorized', message: 'bad token' } })
    await expect(client().listAccounts()).rejects.toMatchObject({
      status: 422,
      code: 'rule_violation',
      message: 'bad token',
    })
  })

  it('throws a TimeoutError when the server never answers', async () => {
    reply = () => {}
    await expect(client(50).listAccounts()).rejects.toMatchObject({ name: 'TimeoutError' })
  })
})
