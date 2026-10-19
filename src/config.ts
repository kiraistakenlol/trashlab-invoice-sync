// Service configuration parsed from environment variables.
import type { OAuthConfig, QboEnvironment } from './qbo/index.js'

export interface ServiceConfig {
  databaseUrl: string
  port: number
  logLevel: string
  invoicing: { baseUrl: string; token: string }
  qbo: {
    oauth: OAuthConfig
    environment: QboEnvironment
    webhookVerifierToken: string | null
    connectionFile: string
  }
  workerConcurrency: number
  pollIntervalMs: number
  workerIdleMs: number
}

// Names each missing or malformed variable, never its value.
export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`)
    this.name = 'ConfigError'
  }
}

const QBO_ENVIRONMENTS: QboEnvironment[] = ['sandbox', 'production']

export function loadConfig(env: NodeJS.ProcessEnv): ServiceConfig {
  const problems: string[] = []

  const required = (name: string): string => {
    const value = env[name]
    if (!value) problems.push(`${name} is required`)
    return value ?? ''
  }

  const positiveInt = (name: string, fallback: number): number => {
    const value = env[name]
    if (!value) return fallback
    const parsed = Number(value)
    if (!Number.isInteger(parsed) || parsed <= 0) {
      problems.push(`${name} must be a positive integer`)
    }
    return parsed
  }

  const config: ServiceConfig = {
    databaseUrl: required('DATABASE_URL'),
    port: positiveInt('PORT', 3000),
    logLevel: env.LOG_LEVEL || 'info',
    invoicing: { baseUrl: required('INVOICING_API_URL'), token: required('INVOICING_API_TOKEN') },
    qbo: {
      oauth: {
        clientId: required('QBO_CLIENT_ID'),
        clientSecret: required('QBO_CLIENT_SECRET'),
        redirectUri: required('QBO_REDIRECT_URI'),
      },
      environment: required('QBO_ENVIRONMENT') as QboEnvironment,
      webhookVerifierToken: env.QBO_WEBHOOK_VERIFIER_TOKEN || null,
      connectionFile: required('QBO_CONNECTION_FILE'),
    },
    workerConcurrency: positiveInt('WORKER_CONCURRENCY', 2),
    pollIntervalMs: positiveInt('POLL_INTERVAL_MS', 60_000),
    workerIdleMs: positiveInt('WORKER_IDLE_MS', 1_000),
  }

  const { environment } = config.qbo
  if (environment && !QBO_ENVIRONMENTS.includes(environment)) {
    problems.push(`QBO_ENVIRONMENT must be one of ${QBO_ENVIRONMENTS.join(', ')}`)
  }
  if (problems.length > 0) throw new ConfigError(problems)
  return config
}
