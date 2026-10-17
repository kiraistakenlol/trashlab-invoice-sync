import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { signQboWebhook, verifyQboWebhook } from '../../../src/qbo/webhooks.js'

const body = '{"eventNotifications":[]}'
const token = 'verifier-token'

describe('qbo webhook signature', () => {
  it('signs as base64 HMAC-SHA256 of the raw body', () =>
    expect(signQboWebhook(body, token)).toBe(
      createHmac('sha256', token).update(body).digest('base64')
    ))
  it('verifies its own signature', () =>
    expect(verifyQboWebhook(body, signQboWebhook(body, token), token)).toBe(true))
  it('rejects a signature over a different body', () =>
    expect(verifyQboWebhook('{}', signQboWebhook(body, token), token)).toBe(false))
  it('rejects a missing signature', () =>
    expect(verifyQboWebhook(body, undefined, token)).toBe(false))
  it('rejects a malformed signature without throwing', () =>
    expect(verifyQboWebhook(body, 'short', token)).toBe(false))
})
