import { existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fileTokenStore } from '../../../src/qbo/tokens.js'

const tokens = {
  realmId: '123',
  accessToken: 'a',
  accessTokenExpiresAt: new Date('2026-10-18T10:00:00.000Z'),
  refreshToken: 'r',
  refreshTokenExpiresAt: new Date('2027-01-01T00:00:00.000Z'),
}

describe('fileTokenStore', () => {
  const path = () => join(mkdtempSync(join(tmpdir(), 'tokens-')), 'connection.json')

  it('loads nothing before the first save', async () => {
    expect(await fileTokenStore(path()).load()).toBeNull()
  })

  it('round-trips tokens with their expiry dates, owner-only', async () => {
    const file = path()
    await fileTokenStore(file).save(tokens)
    expect(await fileTokenStore(file).load()).toEqual(tokens)
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('replaces an existing file whole, owner-only, leaving no temporary file', async () => {
    const file = path()
    writeFileSync(file, '{}', { mode: 0o644 })
    await fileTokenStore(file).save(tokens)
    expect(await fileTokenStore(file).load()).toEqual(tokens)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(existsSync(`${file}.tmp`)).toBe(false)
  })
})
