// QBO webhook payload shape and intuit-signature compute / verify.
import { createHmac, timingSafeEqual } from 'node:crypto'

export interface QboWebhookEntity {
  name: string
  id: string
  operation: 'Create' | 'Update' | 'Delete' | 'Void' | 'Merge' | 'Emailed'
  lastUpdated: string
}

export interface QboWebhookPayload {
  eventNotifications: {
    realmId: string
    dataChangeEvent: { entities: QboWebhookEntity[] }
  }[]
}

export function signQboWebhook(rawBody: string, verifierToken: string): string {
  return createHmac('sha256', verifierToken).update(rawBody).digest('base64')
}

export function verifyQboWebhook(
  rawBody: string,
  signature: string | undefined,
  verifierToken: string
): boolean {
  if (!signature) return false
  const expected = Buffer.from(signQboWebhook(rawBody, verifierToken))
  const actual = Buffer.from(signature)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
