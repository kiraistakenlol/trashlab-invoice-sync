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

const query = (params: Record<string, string | number | undefined>): string => {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value))
  }
  const text = search.toString()
  return text ? `?${text}` : ''
}

export function createInvoicingClient(config: InvoicingClientConfig): InvoicingClient {
  const base = config.baseUrl.replace(/\/+$/, '')
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS

  async function request(
    method: string,
    path: string,
    options: { body?: unknown; idempotencyKey?: string } = {}
  ): Promise<unknown> {
    const headers: Record<string, string> = { authorization: `Bearer ${config.token}` }
    if (options.body !== undefined) headers['content-type'] = 'application/json'
    if (options.idempotencyKey !== undefined) headers['idempotency-key'] = options.idempotencyKey
    const response = await fetch(`${base}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const parsed: unknown = await response.json().catch(() => undefined)
    if (response.ok) return (parsed as { data: unknown } | undefined)?.data
    throw toApiError(response.status, parsed)
  }

  // 5xx is transient (503); any other unexpected status is a permanent rejection (422).
  function toApiError(status: number, parsed: unknown): InvoicingApiError {
    const envelope = (parsed as { error?: { code?: string; message?: string } } | undefined)?.error
    const known = KNOWN_ERRORS.get(status)
    const message = envelope?.message ?? `invoicing API answered ${status}`
    if (known) {
      const code = (envelope?.code as InvoicingErrorCode | undefined) ?? known
      return new InvoicingApiError(status as 404 | 409 | 422 | 503, code, message)
    }
    return status >= 500
      ? new InvoicingApiError(503, 'unavailable', message)
      : new InvoicingApiError(422, 'rule_violation', message)
  }

  const get = async <T>(path: string): Promise<T | null> => {
    try {
      return (await request('GET', path)) as T
    } catch (error) {
      if (error instanceof InvoicingApiError && error.status === 404) return null
      throw error
    }
  }
  const list = async <T>(path: string): Promise<T[]> => (await request('GET', path)) as T[]
  const create = async <T>(path: string, input: unknown, key: string): Promise<T> =>
    (await request('POST', path, { body: input, idempotencyKey: key })) as T
  const send = async <T>(method: string, path: string, body: object, version: number) =>
    (await request(method, path, { body: { ...body, version } })) as T
  const remove = async <T>(path: string, version: number): Promise<T> =>
    (await request('DELETE', `${path}${query({ version })}`)) as T

  return {
    getAccount: (id) => get(`/accounts/${encodeURIComponent(id)}`),
    listAccounts: () => list('/accounts'),
    createAccount: (input, key) => create('/accounts', input, key),
    updateAccount: (id, patch, version) =>
      send('PATCH', `/accounts/${encodeURIComponent(id)}`, patch, version),

    getItem: (id) => get(`/items/${encodeURIComponent(id)}`),
    listItems: () => list('/items'),
    createItem: (input, key) => create('/items', input, key),
    updateItem: (id, patch, version) =>
      send('PATCH', `/items/${encodeURIComponent(id)}`, patch, version),

    getCustomer: (id) => get(`/customers/${encodeURIComponent(id)}`),
    listCustomers: () => list('/customers'),
    createCustomer: (input, key) => create('/customers', input, key),
    updateCustomer: (id, patch, version) =>
      send('PATCH', `/customers/${encodeURIComponent(id)}`, patch, version),

    getInvoice: (id) => get(`/invoices/${encodeURIComponent(id)}`),
    listInvoices: (filter = {}) =>
      list(`/invoices${query({ customerId: filter.customerId, number: filter.number })}`),
    createInvoice: (input, key) => create('/invoices', input, key),
    replaceInvoice: (id, input, version) =>
      send('PUT', `/invoices/${encodeURIComponent(id)}`, input, version),
    voidInvoice: (id, version) =>
      send('POST', `/invoices/${encodeURIComponent(id)}/void`, {}, version),
    deleteInvoice: (id, version) => remove(`/invoices/${encodeURIComponent(id)}`, version),

    getPayment: (id) => get(`/payments/${encodeURIComponent(id)}`),
    listPayments: (filter = {}) => list(`/payments${query({ customerId: filter.customerId })}`),
    createPayment: (input, key) => create('/payments', input, key),
    replacePayment: (id, input, version) =>
      send('PUT', `/payments/${encodeURIComponent(id)}`, input, version),
    deletePayment: (id, version) => remove(`/payments/${encodeURIComponent(id)}`, version),

    listEvents: (after, limit) => list(`/events${query({ after: after ?? undefined, limit })}`),
  }
}
