// The sync's dependencies and tunables, handed in by whoever runs it.
import type { Kysely } from 'kysely'
import type { Logger } from 'pino'
import type { Clock } from '../clock.js'
import type { Database } from '../db/database.js'
import type { InvoicingClient } from '../invoicing/client.js'
import type { QboApi } from '../qbo/api.js'

export interface SyncConfig {
  leaseMs: number
  maxAttempts: number
  backoffBaseMs: number
  backoffMaxMs: number
  staleRetries: number
  cdcStepBackMs: number
  qboWebhookVerifierToken: string | null
}

export const DEFAULT_SYNC_CONFIG: Omit<SyncConfig, 'qboWebhookVerifierToken'> = {
  leaseMs: 60_000,
  maxAttempts: 8,
  backoffBaseMs: 1_000,
  backoffMaxMs: 300_000,
  staleRetries: 3,
  cdcStepBackMs: 5_000,
}

export interface SyncContext {
  db: Kysely<Database>
  invoicing: InvoicingClient
  qbo: QboApi
  clock: Clock
  random: () => number
  config: SyncConfig
  log: Logger
  jobId?: string // the job this context runs for, carried into its audit entries
}
