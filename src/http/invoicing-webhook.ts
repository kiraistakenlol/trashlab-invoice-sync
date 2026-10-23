// Invoicing change notifications: each queues a sync of the record it names.
import { ENTITY_TYPES } from '../db/database.js'
import type { InvoicingEvent } from '../invoicing/types.js'
import { notify } from '../sync/intake.js'
import type { RouteOptions, SyncServer } from './envelope.js'

const eventSchema = {
  body: {
    type: 'object',
    required: ['entityType', 'entityId', 'kind', 'version'],
    properties: {
      entityType: { enum: [...ENTITY_TYPES] },
      entityId: { type: 'string' },
      kind: { type: 'string' },
      version: { type: 'integer' },
    },
  },
}

export async function invoicingWebhookRoutes(
  app: SyncServer,
  { ctx }: RouteOptions
): Promise<void> {
  app.post<{ Body: InvoicingEvent }>(
    '/webhooks/invoicing',
    { schema: eventSchema },
    async (req) => {
      const { entityType, entityId, kind, version } = req.body
      const ref = { system: 'invoicing' as const, entityType, entityId }
      await notify(ctx, ref, { source: 'webhook', kind, version })
      return {}
    }
  )
}
