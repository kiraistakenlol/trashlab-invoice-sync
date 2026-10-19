// The QBO client's token handling, with fetch stubbed for both the API and the token endpoint.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createQboClient } from '../../../src/qbo/client.js'
import type { StoredTokens, TokenStore } from '../../../src/qbo/tokens.js'

const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer'
const HOUR = 3_600_000

const stored: StoredTokens = {
  realmId: 'realm-1',
  accessToken: 'old-access',
  accessTokenExpiresAt: new Date(Date.now() + HOUR),
  refreshToken: 'old-refresh',
  refreshTokenExpiresAt: new Date(Date.now() + 100 * HOUR),
}

let saved: StoredTokens
let tokenStore: TokenStore
// answers API calls in order; `apiStatuses` is consumed per call, then 200
let apiStatuses: number[]
let apiAuth: string[]
let refreshCalls: number

beforeEach(() => {
  saved = stored
  tokenStore = {
    load: async () => saved,
    save: async (t) => {
      saved = t
    },
  }
  apiStatuses = []
  apiAuth = []
  refreshCalls = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: URL | string, init: RequestInit) => {
      if (String(url) === TOKEN_URL) {
        refreshCalls++
        await new Promise((r) => setTimeout(r, 10))
        return Response.json({
          access_token: `new-access-${refreshCalls}`,
          refresh_token: `new-refresh-${refreshCalls}`,
          expires_in: 3600,
          x_refresh_token_expires_in: 8_000_000,
        })
      }
      apiAuth.push((init.headers as Record<string, string>).authorization!)
      return Response.json({}, { status: apiStatuses.shift() ?? 200 })
    })
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const client = () =>
  createQboClient({
    oauth: { clientId: 'id', clientSecret: 'secret', redirectUri: 'http://localhost/cb' },
    environment: 'sandbox',
    tokenStore,
  })

describe('R3a 401 from QBO', () => {
  it('refreshes once, saves the new tokens and retries with the new access token', async () => {
    apiStatuses = [401]
    const res = await client().request('GET', '/invoice/1')
    expect(res.status).toBe(200)
    expect(refreshCalls).toBe(1)
    expect(saved).toMatchObject({ accessToken: 'new-access-1', refreshToken: 'new-refresh-1' })
    expect(apiAuth).toEqual(['Bearer old-access', 'Bearer new-access-1'])
  })

  it('returns a second 401 as is, without looping', async () => {
    apiStatuses = [401, 401]
    const res = await client().request('GET', '/invoice/1')
    expect(res.status).toBe(401)
    expect(refreshCalls).toBe(1)
    expect(apiAuth).toHaveLength(2)
  })

  it('shares one refresh between concurrent requests', async () => {
    apiStatuses = [401, 401]
    const c = client()
    const results = await Promise.all([c.request('GET', '/a'), c.request('GET', '/b')])
    expect(results.map((r) => r.status)).toEqual([200, 200])
    expect(refreshCalls).toBe(1)
    expect(apiAuth.filter((a) => a === 'Bearer new-access-1')).toHaveLength(2)
  })
})
