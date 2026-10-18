// Tokens for one connected QBO company (realm) and where they are stored.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

export interface StoredTokens {
  realmId: string
  accessToken: string
  accessTokenExpiresAt: Date
  refreshToken: string
  refreshTokenExpiresAt: Date
}

// Where tokens live is up to the caller: a file for a single process, a database for
// several. Intuit may rotate the refresh token on every refresh, so `save`
// must persist the latest one before it is used again.
export interface TokenStore {
  load(): Promise<StoredTokens | null>
  save(tokens: StoredTokens): Promise<void>
}

// A JSON file holding one connection, written owner-only.
export function fileTokenStore(path: string): TokenStore {
  return {
    async load() {
      if (!existsSync(path)) return null
      const stored = JSON.parse(readFileSync(path, 'utf8'))
      return {
        ...stored,
        accessTokenExpiresAt: new Date(stored.accessTokenExpiresAt),
        refreshTokenExpiresAt: new Date(stored.refreshTokenExpiresAt),
      }
    },
    async save(tokens) {
      writeFileSync(path, JSON.stringify(tokens, null, 2) + '\n', { mode: 0o600 })
    },
  }
}
