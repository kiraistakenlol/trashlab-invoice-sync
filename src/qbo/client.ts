// Transport-level QBO Accounting API client: auth, base URL, minor version, requestid,
// timeout. Returns raw responses (status, headers, body, intuit_tid) and leaves retries,
// error classification and entity mapping to the caller.
import { refreshTokens, type OAuthConfig } from './oauth.js';
import type { StoredTokens, TokenStore } from './tokens.js';

const BASE_URLS = {
  sandbox: 'https://sandbox-quickbooks.api.intuit.com',
  production: 'https://quickbooks.api.intuit.com',
} as const;

export type QboEnvironment = keyof typeof BASE_URLS;

export const DEFAULT_MINOR_VERSION = '75';
const REFRESH_MARGIN_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface QboClientConfig {
  oauth: OAuthConfig;
  environment: QboEnvironment;
  tokenStore: TokenStore;
  minorVersion?: string | null; // null: send no minorversion (QBO then uses its default)
}

export interface QboResponse {
  status: number;
  intuitTid: string | null; // Intuit's request trace id
  headers: Record<string, string>;
  body: unknown;
}

export interface RequestOptions {
  query?: Record<string, string>;
  body?: unknown;
  requestId?: string; // QBO's idempotency key for writes
  timeoutMs?: number;
}

export interface QboClient {
  // `path` is relative to /v3/company/{realmId}, e.g. "/invoice/123".
  request(method: string, path: string, opts?: RequestOptions): Promise<QboResponse>;
  query(sql: string): Promise<QboResponse>;
}

export function createQboClient(config: QboClientConfig): QboClient {
  const minorVersion = config.minorVersion === undefined ? DEFAULT_MINOR_VERSION : config.minorVersion;
  let refreshing: Promise<StoredTokens> | null = null;

  async function currentTokens(): Promise<StoredTokens> {
    const tokens = await config.tokenStore.load();
    if (!tokens) throw new Error('QBO is not connected: no tokens stored');
    if (tokens.accessTokenExpiresAt.getTime() - Date.now() > REFRESH_MARGIN_MS) return tokens;
    // One refresh at a time: concurrent requests share it instead of racing with the
    // same refresh token.
    refreshing ??= (async () => {
      const fresh = await refreshTokens(config.oauth, tokens.refreshToken);
      const next = { realmId: tokens.realmId, ...fresh };
      await config.tokenStore.save(next);
      return next;
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  async function request(method: string, path: string, opts: RequestOptions = {}): Promise<QboResponse> {
    const tokens = await currentTokens();
    const url = new URL(`${BASE_URLS[config.environment]}/v3/company/${tokens.realmId}${path}`);
    url.search = new URLSearchParams({
      ...Object.fromEntries(url.searchParams), // a query string written in `path`
      ...(minorVersion !== null ? { minorversion: minorVersion } : {}),
      ...(opts.requestId ? { requestid: opts.requestId } : {}),
      ...opts.query,
    }).toString();

    const res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${tokens.accessToken}`,
        accept: 'application/json',
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });

    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // non-JSON response - keep raw text
    }
    return {
      status: res.status,
      intuitTid: res.headers.get('intuit_tid'),
      headers: Object.fromEntries(res.headers),
      body,
    };
  }

  return {
    request,
    query: (sql) => request('GET', '/query', { query: { query: sql } }),
  };
}
