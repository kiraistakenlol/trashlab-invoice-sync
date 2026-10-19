// The invoicing contract's HTTP API over an InvoicingClient: routes, auth and envelopes.
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import type { InvoicingClient } from '../src/invoicing/client.js'
import { InvoicingApiError } from '../src/invoicing/errors.js'

type Body = Record<string, unknown>

const envelope = (code: string, message: string) => ({ error: { code, message } })

const ruleViolation = (message: string) => new InvoicingApiError(422, 'rule_violation', message)

function idempotencyKey(req: FastifyRequest): string {
  const key = req.headers['idempotency-key']
  if (typeof key !== 'string' || key === '') throw ruleViolation('Idempotency-Key is required')
  return key
}

function version(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isInteger(n)) throw ruleViolation('version is required')
  return n
}

// the body of an update without its version, and that version
function versioned(req: FastifyRequest): [Body, number] {
  const { version: v, ...rest } = (req.body ?? {}) as Body
  return [rest, version(v)]
}

async function found<T>(read: Promise<T | null>): Promise<{ data: T }> {
  const record = await read
  if (record === null) throw new InvoicingApiError(404, 'not_found', 'Not found')
  return { data: record }
}

export function buildInvoicingServer(store: InvoicingClient, token: string): FastifyInstance {
  const app = Fastify()

  app.addHook('onRequest', async (req, reply) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      return reply.status(401).send(envelope('unauthorized', 'Bearer token required'))
    }
  })

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof InvoicingApiError) {
      return reply.status(err.status).send(envelope(err.code, err.message))
    }
    const { statusCode, message } = err as { statusCode?: number; message?: string }
    if (statusCode && statusCode < 500) {
      return reply.status(statusCode).send(envelope('bad_request', message ?? 'bad request'))
    }
    return reply.status(500).send(envelope('internal_error', 'internal error'))
  })
  app.setNotFoundHandler((_req, reply) =>
    reply.status(404).send(envelope('not_found', 'Not found'))
  )

  type Id = { Params: { id: string } }

  const catalogue = [
    ['accounts', store.getAccount, store.listAccounts, store.createAccount, store.updateAccount],
    ['items', store.getItem, store.listItems, store.createItem, store.updateItem],
    [
      'customers',
      store.getCustomer,
      store.listCustomers,
      store.createCustomer,
      store.updateCustomer,
    ],
  ] as const
  for (const [path, get, list, create, update] of catalogue) {
    app.get(`/${path}`, async () => ({ data: await list.call(store) }))
    app.post(`/${path}`, async (req, reply) => {
      const record = await create.call(store, req.body as never, idempotencyKey(req))
      return reply.status(201).send({ data: record })
    })
    app.get<Id>(`/${path}/:id`, (req) => found(get.call(store, req.params.id)))
    app.patch<Id>(`/${path}/:id`, async (req) => {
      const [patch, v] = versioned(req)
      return { data: await update.call(store, req.params.id, patch as never, v) }
    })
  }

  app.get<{ Querystring: { customerId?: string; number?: string } }>('/invoices', async (req) => ({
    data: await store.listInvoices({ customerId: req.query.customerId, number: req.query.number }),
  }))
  app.post('/invoices', async (req, reply) => {
    const record = await store.createInvoice(req.body as never, idempotencyKey(req))
    return reply.status(201).send({ data: record })
  })
  app.get<Id>('/invoices/:id', (req) => found(store.getInvoice(req.params.id)))
  app.put<Id>('/invoices/:id', async (req) => {
    const [input, v] = versioned(req)
    return { data: await store.replaceInvoice(req.params.id, input as never, v) }
  })
  app.post<Id>('/invoices/:id/void', async (req) => {
    const [, v] = versioned(req)
    return { data: await store.voidInvoice(req.params.id, v) }
  })
  app.delete<Id & { Querystring: { version?: string } }>('/invoices/:id', async (req) => ({
    data: await store.deleteInvoice(req.params.id, version(req.query.version)),
  }))

  app.get<{ Querystring: { customerId?: string } }>('/payments', async (req) => ({
    data: await store.listPayments({ customerId: req.query.customerId }),
  }))
  app.post('/payments', async (req, reply) => {
    const record = await store.createPayment(req.body as never, idempotencyKey(req))
    return reply.status(201).send({ data: record })
  })
  app.get<Id>('/payments/:id', (req) => found(store.getPayment(req.params.id)))
  app.put<Id>('/payments/:id', async (req) => {
    const [input, v] = versioned(req)
    return { data: await store.replacePayment(req.params.id, input as never, v) }
  })
  app.delete<Id & { Querystring: { version?: string } }>('/payments/:id', async (req) => ({
    data: await store.deletePayment(req.params.id, version(req.query.version)),
  }))

  app.get<{ Querystring: { after?: string; limit?: string } }>('/events', async (req) => ({
    data: await store.listEvents(
      req.query.after ?? null,
      req.query.limit === undefined ? undefined : Number(req.query.limit)
    ),
  }))

  return app
}
