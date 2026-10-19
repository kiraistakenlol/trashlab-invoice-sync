import { describe, expect, it } from 'vitest'
import { ConfigError, loadConfig } from '../../src/config.js'

const REQUIRED = {
  DATABASE_URL: 'postgres://sync:sync@localhost:5432/invoice_sync',
  INVOICING_API_URL: 'http://localhost:4000',
  INVOICING_API_TOKEN: 'invoicing-token',
  QBO_CLIENT_ID: 'client-id',
  QBO_CLIENT_SECRET: 'client-secret',
  QBO_REDIRECT_URI: 'http://localhost:3000/callback',
  QBO_ENVIRONMENT: 'sandbox',
  QBO_WEBHOOK_VERIFIER_TOKEN: 'verifier',
  QBO_CONNECTION_FILE: 'qbo-playground/.qbo-connection.json',
}

describe('loadConfig', () => {
  it('names every missing required variable in one error', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL[\s\S]*INVOICING_API_URL/)
    expect(() => loadConfig({})).toThrow(/QBO_CONNECTION_FILE/)
  })

  it('applies defaults to the optional variables', () => {
    const config = loadConfig(REQUIRED)
    expect(config).toMatchObject({
      databaseUrl: REQUIRED.DATABASE_URL,
      port: 3000,
      logLevel: 'info',
      invoicing: { baseUrl: REQUIRED.INVOICING_API_URL, token: REQUIRED.INVOICING_API_TOKEN },
      qbo: {
        oauth: {
          clientId: REQUIRED.QBO_CLIENT_ID,
          clientSecret: REQUIRED.QBO_CLIENT_SECRET,
          redirectUri: REQUIRED.QBO_REDIRECT_URI,
        },
        environment: 'sandbox',
        webhookVerifierToken: REQUIRED.QBO_WEBHOOK_VERIFIER_TOKEN,
        connectionFile: REQUIRED.QBO_CONNECTION_FILE,
      },
      workerConcurrency: 2,
      pollIntervalMs: 60_000,
      workerIdleMs: 1_000,
    })
  })

  it('reads the optional variables when set', () => {
    const config = loadConfig({
      ...REQUIRED,
      PORT: '8080',
      LOG_LEVEL: 'debug',
      WORKER_CONCURRENCY: '4',
      POLL_INTERVAL_MS: '5000',
      WORKER_IDLE_MS: '250',
    })
    expect(config).toMatchObject({
      port: 8080,
      logLevel: 'debug',
      workerConcurrency: 4,
      pollIntervalMs: 5000,
      workerIdleMs: 250,
    })
  })

  it('rejects malformed values, listing each', () => {
    const attempt = () =>
      loadConfig({ ...REQUIRED, QBO_ENVIRONMENT: 'staging', PORT: 'abc', WORKER_CONCURRENCY: '0' })
    expect(attempt).toThrow(/QBO_ENVIRONMENT/)
    expect(attempt).toThrow(/PORT/)
    expect(attempt).toThrow(/WORKER_CONCURRENCY/)
  })

  it('names the problems without the values', () => {
    const attempt = () => loadConfig({ ...REQUIRED, DATABASE_URL: '', PORT: 'not-a-port' })
    expect(attempt).toThrow(ConfigError)
    expect(attempt).toThrow(
      expect.objectContaining({
        problems: ['DATABASE_URL is required', 'PORT must be a positive integer'],
      })
    )
  })
})
