import { describe, expect, it } from 'vitest'
import { InvoicingApiError } from '../../../src/invoicing/errors.js'
import { QboApiError } from '../../../src/qbo/api.js'
import { BlockedError, classify, StaleError, type FailureKind } from '../../../src/sync/errors.js'
import { timeoutError } from '../../fakes/failures.js'

const qbo = (status: number, codes: string[] = [], retryAfterMs: number | null = null) =>
  new QboApiError(status, codes, retryAfterMs, null, 'qbo')

describe('classify', () => {
  it.each<[string, unknown, FailureKind, number | null]>([
    ['timeout', timeoutError(), 'transient', null],
    ['network failure', new TypeError('fetch failed'), 'transient', null],
    ['body cut off', new TypeError('terminated'), 'transient', null],
    ...['ECONNRESET', 'UND_ERR_SOCKET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].map(
      (code): [string, unknown, FailureKind, number | null] => [
        `socket error ${code}`,
        new TypeError('other side closed', { cause: Object.assign(new Error(code), { code }) }),
        'transient',
        null,
      ]
    ),
    ['plain TypeError', new TypeError('x is undefined'), 'permanent', null],
    [
      'TypeError with an unrelated cause',
      new TypeError('x is undefined', { cause: new Error('nope') }),
      'permanent',
      null,
    ],
    ['QBO 500', qbo(500, ['10000']), 'transient', null],
    ['QBO 503', qbo(503), 'transient', null],
    ['QBO 429 with retry-after', qbo(429, ['3001'], 2000), 'transient', 2000],
    ['QBO 401', qbo(401, ['3200']), 'transient', null],
    ['QBO 425', qbo(425), 'transient', null],
    ['QBO 200 without its entity', qbo(200), 'transient', null],
    ['QBO 200 with a fault', qbo(200, ['2020']), 'permanent', null],
    ['invoicing 503', new InvoicingApiError(503, 'unavailable', 'down'), 'transient', null],
    ['BlockedError', new BlockedError('customer c1'), 'transient', null],
    ['QBO 5010', qbo(400, ['5010']), 'stale', null],
    [
      'invoicing version_conflict',
      new InvoicingApiError(409, 'version_conflict', 'v'),
      'stale',
      null,
    ],
    ['StaleError', new StaleError(), 'stale', null],
    ['QBO 400 validation', qbo(400, ['2020']), 'permanent', null],
    ['QBO 610', qbo(400, ['610']), 'permanent', null],
    ['invoicing 404', new InvoicingApiError(404, 'not_found', 'nf'), 'permanent', null],
    [
      'invoicing 409 number_taken',
      new InvoicingApiError(409, 'number_taken', 'n'),
      'permanent',
      null,
    ],
    ['invoicing 422', new InvoicingApiError(422, 'rule_violation', 'r'), 'permanent', null],
    ['unknown error', new Error('boom'), 'permanent', null],
  ])('%s', (_name, error, kind, retryAfterMs) => {
    expect(classify(error)).toEqual({ kind, retryAfterMs })
  })

  it('BlockedError names its dependency', () => {
    expect(new BlockedError('customer c1').message).toContain('customer c1')
  })
})
