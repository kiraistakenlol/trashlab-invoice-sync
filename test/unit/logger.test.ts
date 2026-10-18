import { describe, expect, it } from 'vitest'
import { createLogger } from '../../src/logger.js'

describe('createLogger', () => {
  it('redacts credentials', () => {
    const lines: string[] = []
    const log = createLogger('info', { write: (line: string) => lines.push(line) })
    log.info(
      {
        req: { headers: { authorization: 'Bearer x', 'intuit-signature': 'sig-z' } },
        accessToken: 'y',
        tokens: { refreshToken: 'r', token: 't' },
        oauth: { clientSecret: 's' },
      },
      'hello'
    )
    const out = lines.join('')
    expect(out).toContain('hello')
    for (const secret of ['Bearer x', '"y"', 'sig-z', '"r"', '"t"', '"s"']) {
      expect(out).not.toContain(secret)
    }
  })

  it('honours the level', () => {
    const lines: string[] = []
    const log = createLogger('warn', { write: (line: string) => lines.push(line) })
    log.info('quiet')
    log.warn('loud')
    expect(lines.join('')).not.toContain('quiet')
    expect(lines.join('')).toContain('loud')
  })
})
