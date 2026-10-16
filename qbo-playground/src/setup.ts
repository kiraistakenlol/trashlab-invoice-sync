// Wires qbo-client to the repo-root .env for local scripts.
import { createQboClient, type OAuthConfig, type QboEnvironment, type StoredTokens, type TokenStore } from 'qbo-client';
import { readEnv, requireEnv, writeEnv } from './env.js';

export function oauthConfig(): OAuthConfig {
  const env = readEnv();
  return {
    clientId: requireEnv(env, 'QBO_CLIENT_ID'),
    clientSecret: requireEnv(env, 'QBO_CLIENT_SECRET'),
    redirectUri: requireEnv(env, 'QBO_REDIRECT_URI'),
  };
}

export const envTokenStore: TokenStore = {
  async load() {
    const env = readEnv();
    if (!env.QBO_REALM_ID || !env.QBO_REFRESH_TOKEN) return null;
    return {
      realmId: env.QBO_REALM_ID,
      accessToken: env.QBO_ACCESS_TOKEN ?? '',
      accessTokenExpiresAt: new Date(env.QBO_ACCESS_TOKEN_EXPIRES_AT ?? 0),
      refreshToken: env.QBO_REFRESH_TOKEN,
      refreshTokenExpiresAt: new Date(env.QBO_REFRESH_TOKEN_EXPIRES_AT ?? 0),
    };
  },
  async save(tokens: StoredTokens) {
    writeEnv({
      QBO_REALM_ID: tokens.realmId,
      QBO_ACCESS_TOKEN: tokens.accessToken,
      QBO_ACCESS_TOKEN_EXPIRES_AT: tokens.accessTokenExpiresAt.toISOString(),
      QBO_REFRESH_TOKEN: tokens.refreshToken,
      QBO_REFRESH_TOKEN_EXPIRES_AT: tokens.refreshTokenExpiresAt.toISOString(),
    });
  },
};

export function client() {
  return createQboClient({
    oauth: oauthConfig(),
    environment: (readEnv().QBO_ENVIRONMENT ?? 'sandbox') as QboEnvironment,
    tokenStore: envTokenStore,
  });
}
