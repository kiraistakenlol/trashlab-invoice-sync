// Intuit OAuth2 (authorization-code flow + refresh).
const AUTHORIZE_URL = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
export const ACCOUNTING_SCOPE = 'com.intuit.quickbooks.accounting';

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface TokenSet {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number; // seconds
  x_refresh_token_expires_in: number; // seconds
}

export function authorizeUrl(config: OAuthConfig, state: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: ACCOUNTING_SCOPE,
    state,
  }).toString();
  return url.toString();
}

export function exchangeCode(config: OAuthConfig, code: string): Promise<TokenSet> {
  return tokenRequest(config, { grant_type: 'authorization_code', code, redirect_uri: config.redirectUri });
}

export function refreshTokens(config: OAuthConfig, refreshToken: string): Promise<TokenSet> {
  return tokenRequest(config, { grant_type: 'refresh_token', refresh_token: refreshToken });
}

async function tokenRequest(config: OAuthConfig, body: Record<string, string>): Promise<TokenSet> {
  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      authorization: `Basic ${basic}`,
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`QBO token endpoint ${res.status}: ${text}`);
  const t = JSON.parse(text) as TokenResponse;
  const now = Date.now();
  return {
    accessToken: t.access_token,
    accessTokenExpiresAt: new Date(now + t.expires_in * 1000),
    refreshToken: t.refresh_token,
    refreshTokenExpiresAt: new Date(now + t.x_refresh_token_expires_in * 1000),
  };
}
