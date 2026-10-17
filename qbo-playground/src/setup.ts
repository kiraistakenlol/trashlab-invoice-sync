// Wires the QBO client for local scripts: config from the repo-root .env, connection state
// from a gitignored JSON file.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  createQboClient,
  type OAuthConfig,
  type QboEnvironment,
  type StoredTokens,
  type TokenStore,
} from '../../src/qbo/index.js'
import { readEnv, requireEnv } from './env.js'

// Connection state (realm id + tokens) written by `auth` and on every refresh. Kept apart
// from .env, which is configuration set by a person. Gitignored.
export const CONNECTION_PATH = fileURLToPath(new URL('../.qbo-connection.json', import.meta.url))

export function oauthConfig(): OAuthConfig {
  const env = readEnv()
  return {
    clientId: requireEnv(env, 'QBO_CLIENT_ID'),
    clientSecret: requireEnv(env, 'QBO_CLIENT_SECRET'),
    redirectUri: requireEnv(env, 'QBO_REDIRECT_URI'),
  }
}

export const fileTokenStore: TokenStore = {
  async load() {
    if (!existsSync(CONNECTION_PATH)) return null
    const c = JSON.parse(readFileSync(CONNECTION_PATH, 'utf8'))
    return {
      ...c,
      accessTokenExpiresAt: new Date(c.accessTokenExpiresAt),
      refreshTokenExpiresAt: new Date(c.refreshTokenExpiresAt),
    }
  },
  async save(tokens: StoredTokens) {
    writeFileSync(CONNECTION_PATH, JSON.stringify(tokens, null, 2) + '\n', { mode: 0o600 })
  },
}

export function client(opts: { minorVersion?: string | null } = {}) {
  return createQboClient({
    oauth: oauthConfig(),
    environment: (readEnv().QBO_ENVIRONMENT ?? 'sandbox') as QboEnvironment,
    tokenStore: fileTokenStore,
    ...opts,
  })
}
