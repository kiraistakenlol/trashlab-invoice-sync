// Tokens for one connected QBO company (realm).
export interface StoredTokens {
  realmId: string;
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

// Where tokens live is up to the caller: a file for local scripts, the database for a
// long-running service. Intuit may rotate the refresh token on every refresh, so `save`
// must persist the latest one before it is used again.
export interface TokenStore {
  load(): Promise<StoredTokens | null>;
  save(tokens: StoredTokens): Promise<void>;
}
