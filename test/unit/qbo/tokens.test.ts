import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fileTokenStore } from '../../../src/qbo/tokens.js'

describe('fileTokenStore', () => {
  const path = () => join(mkdtempSync(join(tmpdir(), 'tokens-')), 'connection.json')

  it('loads nothing before the first save', async () => {
    expect(await fileTokenStore(path()).load()).toBeNull()
  })

  it('round-trips tokens with their expiry dates, owner-only', async () => {
    const file = path()
    const tokens = {
      realmId: '123',
      accessToken: 'a',
      accessTokenExpiresAt: new Date('2026-10-18T10:00:00.000Z'),
      refreshToken: 'r',
      refreshTokenExpiresAt: new Date('2027-01-01T00:00:00.000Z'),
    }
    await fileTokenStore(file).save(tokens)
    expect(await fileTokenStore(file).load()).toEqual(tokens)
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })
})
