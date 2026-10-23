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

// Reads variables, collecting a problem for each missing or malformed one.
class EnvReader {
  readonly problems: string[] = []

  constructor(private readonly env: NodeJS.ProcessEnv) {}

  required(name: string): string {
    const value = this.env[name]
    if (!value) {
      this.problems.push(`${name} is required`)
    }
    return value ?? ''
  }

  optional(name: string): string | null {
    return this.env[name] || null
  }

  positiveInt(name: string, fallback: number): number {
    const value = this.env[name]
    if (!value) {
      return fallback
    }
    const parsed = Number(value)
    if (!Number.isInteger(parsed) || parsed <= 0) {
      this.problems.push(`${name} must be a positive integer`)
    }
    return parsed
  }

  oneOf<T extends string>(name: string, allowed: readonly T[]): T {
    const value = this.required(name)
    if (value && !allowed.includes(value as T)) {
      this.problems.push(`${name} must be one of ${allowed.join(', ')}`)
    }
    return value as T
  }
}

export function loadConfig(env: NodeJS.ProcessEnv): ServiceConfig {
  const vars = new EnvReader(env)
  const config: ServiceConfig = {
    databaseUrl: vars.required('DATABASE_URL'),
    port: vars.positiveInt('PORT', 3000),
    logLevel: vars.optional('LOG_LEVEL') ?? 'info',
    invoicing: {
      baseUrl: vars.required('INVOICING_API_URL'),
      token: vars.required('INVOICING_API_TOKEN'),
    },
    qbo: {
      oauth: {
        clientId: vars.required('QBO_CLIENT_ID'),
        clientSecret: vars.required('QBO_CLIENT_SECRET'),
        redirectUri: vars.required('QBO_REDIRECT_URI'),
      },
      environment: vars.oneOf('QBO_ENVIRONMENT', QBO_ENVIRONMENTS),
      webhookVerifierToken: vars.optional('QBO_WEBHOOK_VERIFIER_TOKEN'),
      connectionFile: vars.required('QBO_CONNECTION_FILE'),
    },
    workerConcurrency: vars.positiveInt('WORKER_CONCURRENCY', 2),
    pollIntervalMs: vars.positiveInt('POLL_INTERVAL_MS', 60_000),
    workerIdleMs: vars.positiveInt('WORKER_IDLE_MS', 1_000),
  }
  if (vars.problems.length > 0) {
    throw new ConfigError(vars.problems)
  }
  return config
}
