// QBO change notifications: a verified delivery queues a sync of each entity it names.
import { verifyQboWebhook, type QboWebhookPayload } from '../qbo/webhooks.js'
import type { SyncContext } from '../sync/context.js'
import { entityTypeOfQbo, notify } from '../sync/intake.js'
import { errorBody, type RouteOptions, type SyncServer } from './envelope.js'

async function notifyEntities(ctx: SyncContext, payload: QboWebhookPayload): Promise<void> {
  for (const notification of payload.eventNotifications) {
    for (const entity of notification.dataChangeEvent.entities) {
      const entityType = entityTypeOfQbo(entity.name)
      if (!entityType) {
        ctx.log.info({ qboEntity: entity.name, entityId: entity.id }, 'webhook entity skipped')
        continue
      }
      const ref = { system: 'qbo' as const, entityType, entityId: entity.id }
      await notify(ctx, ref, { source: 'webhook', operation: entity.operation })
    }
  }
}

// undefined when the body is not JSON at all
function parsePayload(raw: string): QboWebhookPayload | undefined {
  try {
    return JSON.parse(raw) as QboWebhookPayload
  } catch {
    return undefined
  }
}

// The signature covers the raw bytes, so this plugin's scope keeps the body as a string.
export async function qboWebhookRoutes(
  app: SyncServer,
  { ctx, verifierToken }: RouteOptions & { verifierToken: string }
): Promise<void> {
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) =>
    done(null, body)
  )
  app.post('/webhooks/qbo', async (req, reply) => {
    const raw = req.body as string
    const signature = req.headers['intuit-signature']
    const signed = typeof signature === 'string' ? signature : undefined
    if (!verifyQboWebhook(raw, signed, verifierToken)) {
      return reply.status(401).send(errorBody('invalid_signature', 'Signature check failed'))
    }
    const payload = parsePayload(raw)
    if (payload === undefined) {
      return reply.status(400).send(errorBody('bad_request', 'Body is not valid JSON'))
    }
    if (!Array.isArray(payload?.eventNotifications)) {
      return reply.status(400).send(errorBody('bad_request', 'Missing eventNotifications'))
    }
    await notifyEntities(ctx, payload)
    return {}
  })
}
