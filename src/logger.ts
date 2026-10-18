// The service logger: pino JSON with credentials redacted.
import pino, { type DestinationStream, type Logger } from 'pino'

const SECRET_KEYS = ['accessToken', 'refreshToken', 'clientSecret', 'token']

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers["intuit-signature"]',
  ...SECRET_KEYS,
  ...SECRET_KEYS.map((key) => `*.${key}`),
]

export function createLogger(level: string, destination?: DestinationStream): Logger {
  return pino({ level, redact: REDACT_PATHS }, destination)
}
