// Transport-level QBO Accounting API client: auth, base URL, minor version, requestid,
// timeout. Returns raw responses (status, headers, body, intuit_tid) and leaves retries,
// error classification and entity mapping to the caller.
import { refreshTokens, type OAuthConfig } from './oauth.js'
import type { StoredTokens, TokenStore } from './tokens.js'

const BASE_URLS = {
  sandbox: 'https://sandbox-quickbooks.api.intuit.com',
  production: 'https://quickbooks.api.intuit.com',
} as const

export type QboEnvironment = keyof typeof BASE_URLS

export const DEFAULT_MINOR_VERSION = '75'
const REFRESH_MARGIN_MS = 60_000
const DEFAULT_TIMEOUT_MS = 30_000

export interface QboClientConfig {
  oauth: OAuthConfig
  environment: QboEnvironment
  tokenStore: TokenStore
  minorVersion?: string | null // null: send no minorversion (QBO then uses its default)
}

export interface QboResponse {
  status: number
  intuitTid: string | null // Intuit's request trace id
  headers: Record<string, string>
  body: unknown
}

export interface RequestOptions {
  query?: Record<string, string>
  body?: unknown
  requestId?: string // QBO's idempotency key for writes
  timeoutMs?: number
}

export interface QboClient {
  // `path` is relative to /v3/company/{realmId}, e.g. "/invoice/123".
  request(method: string, path: string, opts?: RequestOptions): Promise<QboResponse>
  query(sql: string): Promise<QboResponse>
}

function requestUrl(
  environment: QboEnvironment,
  minorVersion: string | null,
  realmId: string,
  path: string,
  opts: RequestOptions
): URL {
  const url = new URL(`${BASE_URLS[environment]}/v3/company/${realmId}${path}`)
  // keeps a query string written in `path`
  const params = new URLSearchParams(url.search)
  if (minorVersion !== null) {
    params.set('minorversion', minorVersion)
  }
  if (opts.requestId) {
    params.set('requestid', opts.requestId)
  }
  for (const [key, value] of Object.entries(opts.query ?? {})) {
    params.set(key, value)
  }
  url.search = params.toString()
  return url
}

async function send(
  url: URL,
  method: string,
  accessToken: string,
  opts: RequestOptions
): Promise<QboResponse> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${accessToken}`,
    accept: 'application/json',
  }
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json'
  }
  const res = await fetch(url, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  })
  const text = await res.text()
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch {
    // a non-JSON body is kept as text
  }
  return {
    status: res.status,
    intuitTid: res.headers.get('intuit_tid'),
    headers: Object.fromEntries(res.headers),
    body,
  }
}

async function refreshStored(config: QboClientConfig, tokens: StoredTokens): Promise<StoredTokens> {
  const fresh = await refreshTokens(config.oauth, tokens.refreshToken)
  const next = { realmId: tokens.realmId, ...fresh }
  await config.tokenStore.save(next)
  return next
}

const isUsable = (tokens: StoredTokens, rejected: string | undefined): boolean =>
  tokens.accessTokenExpiresAt.getTime() - Date.now() > REFRESH_MARGIN_MS &&
  tokens.accessToken !== rejected

export function createQboClient(config: QboClientConfig): QboClient {
  const minorVersion =
    config.minorVersion === undefined ? DEFAULT_MINOR_VERSION : config.minorVersion
  let refreshing: Promise<StoredTokens> | null = null

  // `rejected` is an access token QBO answered 401 to: it is refreshed even when it looks valid,
  // unless the store already holds a newer one
  async function currentTokens(rejected?: string): Promise<StoredTokens> {
    const tokens = await config.tokenStore.load()
    if (!tokens) {
      throw new Error('QBO is not connected: no tokens stored')
    }
    if (isUsable(tokens, rejected)) {
      return tokens
    }
    // one refresh at a time: concurrent requests share it instead of racing with the same
    // refresh token
    refreshing ??= refreshStored(config, tokens).finally(() => {
      refreshing = null
    })
    return refreshing
  }

  async function request(
    method: string,
    path: string,
    opts: RequestOptions = {}
  ): Promise<QboResponse> {
    const attempt = (tokens: StoredTokens) => {
      const url = requestUrl(config.environment, minorVersion, tokens.realmId, path, opts)
      return send(url, method, tokens.accessToken, opts)
    }
    const tokens = await currentTokens()
    const res = await attempt(tokens)
    if (res.status !== 401) {
      return res
    }
    return attempt(await currentTokens(tokens.accessToken))
  }

  return {
    request,
    query: (sql) => request('GET', '/query', { query: { query: sql } }),
  }
}
