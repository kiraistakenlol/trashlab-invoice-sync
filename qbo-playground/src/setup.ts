// Wires the QBO client for local scripts: config from the repo-root .env, connection state
// from a gitignored JSON file.
import { dirname, resolve } from 'node:path'
import {
  createQboClient,
  fileTokenStore,
  type OAuthConfig,
  type QboEnvironment,
} from '../../src/qbo/index.js'
import { ENV_PATH, readEnv, requireEnv } from './env.js'

// Connection state (realm id + tokens) written by `auth` and on every refresh, at
// QBO_CONNECTION_FILE relative to the repo root. Kept apart from .env, which is configuration
// set by a person. Gitignored.
export const CONNECTION_PATH = resolve(
  dirname(ENV_PATH),
  readEnv().QBO_CONNECTION_FILE || 'qbo-playground/.qbo-connection.json'
)

export function oauthConfig(): OAuthConfig {
  const env = readEnv()
  return {
    clientId: requireEnv(env, 'QBO_CLIENT_ID'),
    clientSecret: requireEnv(env, 'QBO_CLIENT_SECRET'),
    redirectUri: requireEnv(env, 'QBO_REDIRECT_URI'),
  }
}

export const tokenStore = fileTokenStore(CONNECTION_PATH)

export function client(opts: { minorVersion?: string | null } = {}) {
  return createQboClient({
    oauth: oauthConfig(),
    environment: (readEnv().QBO_ENVIRONMENT ?? 'sandbox') as QboEnvironment,
    tokenStore,
    ...opts,
  })
}
