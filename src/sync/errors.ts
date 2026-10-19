// Failure classification: what a sync job does after a QBO or invoicing call fails.
import type { IssueKind } from '../db/database.js'
import { InvoicingApiError } from '../invoicing/errors.js'
import { QboApiError } from '../qbo/api.js'

export type FailureKind = 'transient' | 'stale' | 'permanent'

export interface Failure {
  kind: FailureKind
  retryAfterMs: number | null
}

// Thrown to restart the job from a fresh read.
export class StaleError extends Error {
  constructor(message = 'state changed underneath the job') {
    super(message)
    this.name = 'StaleError'
  }
}

// A dependency cannot be linked yet.
export class BlockedError extends Error {
  constructor(dependency: string) {
    super(`blocked on ${dependency}`)
    this.name = 'BlockedError'
  }
}

// Thrown from a write that can't go ahead: the pair is flagged instead of the job failing.
export class FlagError extends Error {
  constructor(
    readonly kind: IssueKind,
    readonly reason: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(reason)
    this.name = 'FlagError'
  }
}

const TRANSIENT_QBO_STATUSES = [401, 425, 429]
const STALE_QBO_CODE = '5010'
const NETWORK_MESSAGES = ['fetch failed', 'terminated']
const SOCKET_CODES = ['ECONNRESET', 'UND_ERR_SOCKET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT']

// undici reports network failures as a TypeError: before a response, or a body cut off midway.
function isNetworkError(error: TypeError): boolean {
  const code = (error.cause as { code?: unknown } | undefined)?.code
  return NETWORK_MESSAGES.includes(error.message) || SOCKET_CODES.includes(code as string)
}

export function classify(error: unknown): Failure {
  const failure = (kind: FailureKind, retryAfterMs: number | null = null): Failure => ({
    kind,
    retryAfterMs,
  })
  if (error instanceof StaleError) return failure('stale')
  if (error instanceof BlockedError) return failure('transient')
  if (error instanceof DOMException && error.name === 'TimeoutError') return failure('transient')
  if (error instanceof TypeError && isNetworkError(error)) return failure('transient')
  if (error instanceof QboApiError) {
    if (error.codes.includes(STALE_QBO_CODE)) return failure('stale')
    // a success status with no fault codes is a response that came back without its entity
    const broken = error.status < 300 && error.codes.length === 0
    if (broken || error.status >= 500 || TRANSIENT_QBO_STATUSES.includes(error.status)) {
      return failure('transient', error.retryAfterMs)
    }
    return failure('permanent')
  }
  if (error instanceof InvoicingApiError) {
    if (error.code === 'version_conflict') return failure('stale')
    return failure(error.status === 503 ? 'transient' : 'permanent')
  }
  return failure('permanent')
}
