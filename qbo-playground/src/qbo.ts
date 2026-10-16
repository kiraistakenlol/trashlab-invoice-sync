// Minimal QBO Accounting API client for exploring the sandbox.
// Refreshes the access token when it is about to expire and returns raw responses,
// so we can see exactly what QBO sends back (status, headers, body).
import { readEnv, requireEnv } from './env.js';
import { refresh, saveTokens } from './oauth.js';

const BASE_URLS = {
  sandbox: 'https://sandbox-quickbooks.api.intuit.com',
  production: 'https://quickbooks.api.intuit.com',
} as const;

export const MINOR_VERSION = '75';
const REFRESH_MARGIN_MS = 60_000;

export interface QboResponse {
  status: number;
  intuitTid: string | null; // Intuit's request trace id, useful when something looks odd
  headers: Record<string, string>;
  body: unknown;
}

export interface RequestOptions {
  query?: Record<string, string>;
  body?: unknown;
  requestId?: string; // QBO's idempotency key for writes
  timeoutMs?: number;
}

async function accessToken(): Promise<string> {
  const env = readEnv();
  const expiresAt = Date.parse(env.QBO_ACCESS_TOKEN_EXPIRES_AT ?? '');
  if (env.QBO_ACCESS_TOKEN && expiresAt - Date.now() > REFRESH_MARGIN_MS) return env.QBO_ACCESS_TOKEN;
  saveTokens(await refresh(requireEnv(env, 'QBO_REFRESH_TOKEN')));
  return requireEnv(readEnv(), 'QBO_ACCESS_TOKEN');
}

// `path` is relative to /v3/company/{realmId}, e.g. "/invoice/123" or "/query".
export async function qbo(method: string, path: string, opts: RequestOptions = {}): Promise<QboResponse> {
  const env = readEnv();
  const environment = (env.QBO_ENVIRONMENT ?? 'sandbox') as keyof typeof BASE_URLS;
  const url = new URL(`${BASE_URLS[environment]}/v3/company/${requireEnv(env, 'QBO_REALM_ID')}${path}`);
  url.search = new URLSearchParams({
    minorversion: MINOR_VERSION,
    ...(opts.requestId ? { requestid: opts.requestId } : {}),
    ...opts.query,
  }).toString();

  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${await accessToken()}`,
      accept: 'application/json',
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
  });

  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // non-JSON (e.g. some error pages) - keep raw text
  }
  return {
    status: res.status,
    intuitTid: res.headers.get('intuit_tid'),
    headers: Object.fromEntries(res.headers),
    body,
  };
}

export function query(sql: string): Promise<QboResponse> {
  return qbo('GET', '/query', { query: { query: sql } });
}
