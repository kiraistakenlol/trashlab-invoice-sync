import { readEnv, requireEnv, writeEnv } from './env.js';

const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number; // seconds
  x_refresh_token_expires_in: number; // seconds
  token_type: string;
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const env = readEnv();
  const basic = Buffer.from(`${requireEnv(env, 'QBO_CLIENT_ID')}:${requireEnv(env, 'QBO_CLIENT_SECRET')}`).toString('base64');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      authorization: `Basic ${basic}`,
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`token endpoint ${res.status}: ${text}`);
  return JSON.parse(text) as TokenResponse;
}

export function exchangeCode(code: string): Promise<TokenResponse> {
  return tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: requireEnv(readEnv(), 'QBO_REDIRECT_URI'),
  });
}

export function refresh(refreshToken: string): Promise<TokenResponse> {
  return tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
}

// Intuit may rotate the refresh token on every refresh, so always persist the latest one.
export function saveTokens(tokens: TokenResponse, realmId?: string): void {
  const now = Date.now();
  writeEnv({
    ...(realmId ? { QBO_REALM_ID: realmId } : {}),
    QBO_ACCESS_TOKEN: tokens.access_token,
    QBO_ACCESS_TOKEN_EXPIRES_AT: new Date(now + tokens.expires_in * 1000).toISOString(),
    QBO_REFRESH_TOKEN: tokens.refresh_token,
    QBO_REFRESH_TOKEN_EXPIRES_AT: new Date(now + tokens.x_refresh_token_expires_in * 1000).toISOString(),
  });
}
