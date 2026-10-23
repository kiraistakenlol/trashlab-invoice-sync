// InvoicingClient over the invoicing system's HTTP API.
import type { InvoicingClient } from './client.js'
import { InvoicingApiError, type InvoicingErrorCode } from './errors.js'

export interface InvoicingClientConfig {
  baseUrl: string
  token: string
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 10_000

const KNOWN_ERRORS = new Map<number, InvoicingErrorCode>([
  [404, 'not_found'],
  [409, 'version_conflict'],
  [422, 'rule_violation'],
  [503, 'unavailable'],
])

const TRANSIENT_STATUSES = [408, 429]

const query = (params: Record<string, string | number | undefined>): string => {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      search.set(key, String(value))
    }
  }
  const text = search.toString()
  return text ? `?${text}` : ''
}

interface Connection {
  base: string
  token: string
  timeoutMs: number
}

// 5xx, 408 and 429 are transient (503); any other unexpected status is a permanent rejection
// (422).
function toApiError(status: number, parsed: unknown): InvoicingApiError {
  const envelope = (parsed as { error?: { code?: string; message?: string } } | undefined)?.error
  const known = KNOWN_ERRORS.get(status)
  const message = envelope?.message ?? `invoicing API answered ${status}`
  if (known) {
    const code = (envelope?.code as InvoicingErrorCode | undefined) ?? known
    return new InvoicingApiError(status as 404 | 409 | 422 | 503, code, message)
  }
  if (status >= 500 || TRANSIENT_STATUSES.includes(status)) {
    return new InvoicingApiError(503, 'unavailable', message)
  }
  return new InvoicingApiError(422, 'rule_violation', message)
}

async function request(
  conn: Connection,
  method: string,
  path: string,
  options: { body?: unknown; idempotencyKey?: string } = {}
): Promise<unknown> {
  const headers: Record<string, string> = { authorization: `Bearer ${conn.token}` }
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json'
  }
  if (options.idempotencyKey !== undefined) {
    headers['idempotency-key'] = options.idempotencyKey
  }
  const response = await fetch(`${conn.base}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(conn.timeoutMs),
  })
  const parsed: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    throw toApiError(response.status, parsed)
  }
  const data = (parsed as { data?: unknown } | undefined)?.data
  // a success always carries data, so one without it is a broken response, never "not found"
  if (data === undefined || data === null) {
    const message = `invoicing API answered ${response.status} without data`
    throw new InvoicingApiError(503, 'unavailable', message)
  }
  return data
}

async function get<T>(conn: Connection, path: string): Promise<T | null> {
  try {
    return (await request(conn, 'GET', path)) as T
  } catch (error) {
    if (error instanceof InvoicingApiError && error.status === 404) {
      return null
    }
    throw error
  }
}

const list = async <T>(conn: Connection, path: string): Promise<T[]> =>
  (await request(conn, 'GET', path)) as T[]

const create = async <T>(conn: Connection, path: string, input: unknown, key: string) =>
  (await request(conn, 'POST', path, { body: input, idempotencyKey: key })) as T

const write = async <T>(
  conn: Connection,
  method: string,
  path: string,
  body: object,
  version: number
) => (await request(conn, method, path, { body: { ...body, version } })) as T

const remove = async <T>(conn: Connection, path: string, version: number): Promise<T> =>
  (await request(conn, 'DELETE', `${path}${query({ version })}`)) as T

const at = (collection: string, id: string) => `/${collection}/${encodeURIComponent(id)}`

export function createInvoicingClient(config: InvoicingClientConfig): InvoicingClient {
  const c: Connection = {
    base: config.baseUrl.replace(/\/+$/, ''),
    token: config.token,
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }
  return {
    getAccount: (id) => get(c, at('accounts', id)),
    listAccounts: () => list(c, '/accounts'),
    createAccount: (input, key) => create(c, '/accounts', input, key),
    updateAccount: (id, patch, version) => write(c, 'PATCH', at('accounts', id), patch, version),

    getItem: (id) => get(c, at('items', id)),
    listItems: () => list(c, '/items'),
    createItem: (input, key) => create(c, '/items', input, key),
    updateItem: (id, patch, version) => write(c, 'PATCH', at('items', id), patch, version),

    getCustomer: (id) => get(c, at('customers', id)),
    listCustomers: () => list(c, '/customers'),
    createCustomer: (input, key) => create(c, '/customers', input, key),
    updateCustomer: (id, patch, version) => write(c, 'PATCH', at('customers', id), patch, version),

    getInvoice: (id) => get(c, at('invoices', id)),
    listInvoices: (filter = {}) =>
      list(c, `/invoices${query({ customerId: filter.customerId, number: filter.number })}`),
    createInvoice: (input, key) => create(c, '/invoices', input, key),
    replaceInvoice: (id, input, version) => write(c, 'PUT', at('invoices', id), input, version),
    voidInvoice: (id, version) => write(c, 'POST', `${at('invoices', id)}/void`, {}, version),
    deleteInvoice: (id, version) => remove(c, at('invoices', id), version),

    getPayment: (id) => get(c, at('payments', id)),
    listPayments: (filter = {}) => list(c, `/payments${query({ customerId: filter.customerId })}`),
    createPayment: (input, key) => create(c, '/payments', input, key),
    replacePayment: (id, input, version) => write(c, 'PUT', at('payments', id), input, version),
    deletePayment: (id, version) => remove(c, at('payments', id), version),

    listEvents: (after, limit) => list(c, `/events${query({ after: after ?? undefined, limit })}`),
  }
}
