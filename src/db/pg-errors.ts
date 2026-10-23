// Postgres error codes the repositories turn into outcomes.

const UNIQUE_VIOLATION = '23505'

export const isUniqueViolation = (error: unknown): boolean =>
  (error as { code?: unknown } | null)?.code === UNIQUE_VIOLATION
