// Error returned by the invoicing system's API.
export type InvoicingErrorCode =
  | 'not_found'
  | 'version_conflict'
  | 'idempotency_mismatch'
  | 'number_taken'
  | 'rule_violation'
  | 'unavailable'

export class InvoicingApiError extends Error {
  constructor(
    readonly status: 404 | 409 | 422 | 503,
    readonly code: InvoicingErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'InvoicingApiError'
  }
}
