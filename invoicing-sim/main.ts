// Runs the in-memory invoicing system over HTTP until SIGINT or SIGTERM, sending each change
// to the sync service's webhook once (best effort; the events feed is the guarantee).
import type { InvoicingEvent } from '../src/invoicing/types.js'
import { InMemoryInvoicing } from './invoicing.js'
import { buildInvoicingServer } from './server.js'

const env = (name: string): string => {
  const value = process.env[name]
  if (!value) {
    throw new Error(`${name} is required`)
  }
  return value
}

const apiUrl = new URL(env('INVOICING_API_URL'))
const webhookUrl = `http://localhost:${process.env.PORT || '3000'}/webhooks/invoicing`

function send(event: InvoicingEvent): void {
  const line = `${event.entityType} ${event.entityId} ${event.kind} v${event.version}`
  fetch(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(event),
  }).then(
    (res) => console.log(`${line} -> webhook ${res.status}`),
    (err: unknown) => console.log(`${line} -> webhook failed: ${String(err)}`)
  )
}

const app = buildInvoicingServer(
  new InMemoryInvoicing({ onEvent: send }),
  env('INVOICING_API_TOKEN')
)
await app.listen({ host: apiUrl.hostname, port: Number(apiUrl.port) })
console.log(`invoicing system on ${apiUrl.origin}, webhooks to ${webhookUrl}`)

const stop = () => void app.close()
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
