// The QBO sandbox client from the playground wiring, raw and typed.
import { existsSync } from 'node:fs'
import { QboApi } from '../../src/qbo/api.js'
import type { QboClient } from '../../src/qbo/client.js'
import { client, CONNECTION_PATH } from '../../qbo-playground/src/setup.js'

export function sandboxClient(): QboClient {
  if (!existsSync(CONNECTION_PATH)) throw new Error('QBO is not connected: run pnpm qbo:auth')
  return client()
}

export function sandboxApi(): QboApi {
  return new QboApi(sandboxClient())
}
