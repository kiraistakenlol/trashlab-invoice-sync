// Failure classification: what a sync job does after a QBO or invoicing call fails.
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
  constructor(readonly dependency: string) {
    super(`blocked on ${dependency}`)
    this.name = 'BlockedError'
  }
}

const TRANSIENT_QBO_STATUSES = [401, 425, 429]
const STALE_QBO_CODE = '5010'

export function classify(error: unknown): Failure {
  const failure = (kind: FailureKind, retryAfterMs: number | null = null): Failure => ({
    kind,
    retryAfterMs,
  })
  if (error instanceof StaleError) return failure('stale')
  if (error instanceof BlockedError) return failure('transient')
  if (error instanceof DOMException && error.name === 'TimeoutError') return failure('transient')
  if (error instanceof TypeError) return failure('transient') // fetch network failure
  if (error instanceof QboApiError) {
    if (error.codes.includes(STALE_QBO_CODE)) return failure('stale')
    if (error.status >= 500 || TRANSIENT_QBO_STATUSES.includes(error.status)) {
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
