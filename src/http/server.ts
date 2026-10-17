// Fastify app: change-notification intake and the read API.
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify'
import type { Logger } from 'pino'
import { NoResultError } from 'kysely'
import type { EntityType, System } from '../db/database.js'
import type { InvoicingEvent } from '../invoicing/types.js'
import { verifyQboWebhook, type QboWebhookPayload } from '../qbo/webhooks.js'
import { auditHistory } from '../store/audit.js'
import { listIssues } from '../store/issues.js'
import { getLink } from '../store/links.js'
import type { SyncContext } from '../sync/context.js'
import { notify } from '../sync/intake.js'

const QBO_ENTITY_TYPES: Record<string, EntityType> = {
  customer: 'customer',
  item: 'item',
  account: 'account',
  invoice: 'invoice',
  payment: 'payment',
}

const SYSTEMS: System[] = ['invoicing', 'qbo']
const ENTITY_TYPES: EntityType[] = ['account', 'item', 'customer', 'invoice', 'payment']

const error = (code: string, message: string) => ({ error: { code, message } })

export type SyncServer = FastifyInstance<Server, IncomingMessage, ServerResponse, Logger>

export function buildServer(ctx: SyncContext): SyncServer {
  const app = Fastify({ loggerInstance: ctx.log })

  app.setErrorHandler((err: FastifyError, _req, reply) => {
    const status = err.statusCode ?? 500
    if (status >= 500) ctx.log.error({ err }, 'request failed')
    return reply
      .status(status)
      .send(error(status >= 500 ? 'internal_error' : 'bad_request', err.message))
  })
  app.setNotFoundHandler((_req, reply) => reply.status(404).send(error('not_found', 'Not found')))

  app.get('/health', async () => ({ data: { status: 'ok' } }))

  // The signature covers the raw bytes, so this scope keeps the body as a string.
  app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) =>
      done(null, body)
    )
    scope.post('/webhooks/qbo', async (req, reply) => {
      const raw = req.body as string
      const signature = req.headers['intuit-signature']
      if (
        !verifyQboWebhook(
          raw,
          typeof signature === 'string' ? signature : undefined,
          ctx.config.qboWebhookVerifierToken
        )
      ) {
        return reply.status(401).send(error('invalid_signature', 'Signature check failed'))
      }
      const payload = JSON.parse(raw) as QboWebhookPayload
      for (const notification of payload.eventNotifications) {
        for (const entity of notification.dataChangeEvent.entities) {
          const entityType = QBO_ENTITY_TYPES[entity.name.toLowerCase()]
          if (!entityType) continue
          await notify(
            ctx,
            { system: 'qbo', entityType, entityId: entity.id },
            { source: 'webhook', operation: entity.operation }
          )
        }
      }
      return {}
    })
  })

  app.post<{ Body: InvoicingEvent }>(
    '/webhooks/invoicing',
    {
      schema: {
        body: {
          type: 'object',
          required: ['entityType', 'entityId', 'kind', 'version'],
          properties: {
            entityType: { enum: ENTITY_TYPES },
            entityId: { type: 'string' },
            kind: { type: 'string' },
            version: { type: 'integer' },
          },
        },
      },
    },
    async (req) => {
      const { entityType, entityId, kind, version } = req.body
      await notify(
        ctx,
        { system: 'invoicing', entityType, entityId },
        { source: 'webhook', kind, version }
      )
      return {}
    }
  )

  app.get<{ Querystring: { system: System; entityType: EntityType; entityId: string } }>(
    '/audit',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['system', 'entityType', 'entityId'],
          properties: {
            system: { enum: SYSTEMS },
            entityType: { enum: ENTITY_TYPES },
            entityId: { type: 'string' },
          },
        },
      },
    },
    async (req) => {
      const { system, entityType, entityId } = req.query
      return { data: await auditHistory(ctx.db, { system, entityType, entityId }) }
    }
  )

  app.get<{ Querystring: { open?: boolean } }>(
    '/issues',
    { schema: { querystring: { type: 'object', properties: { open: { type: 'boolean' } } } } },
    async (req) => ({ data: await listIssues(ctx.db, { open: req.query.open }) })
  )

  app.get<{ Params: { id: string } }>(
    '/links/:id',
    {
      schema: {
        params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      },
    },
    async (req, reply) => {
      try {
        return { data: await getLink(ctx.db, req.params.id) }
      } catch (e) {
        if (e instanceof NoResultError)
          return reply.status(404).send(error('not_found', 'No such link'))
        throw e
      }
    }
  )

  return app
}
