// Fastify app: change-notification intake and the read API.
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify'
import type { Logger } from 'pino'
import { NoResultError } from 'kysely'
import { ENTITY_TYPES, type EntityType, type JobStatus, type System } from '../db/database.js'
import type { InvoicingEvent } from '../invoicing/types.js'
import { verifyQboWebhook, type QboWebhookPayload } from '../qbo/webhooks.js'
import { auditHistory } from '../store/audit.js'
import { getIssue, listIssues } from '../store/issues.js'
import { getJob, listJobs, requeueJob } from '../store/jobs.js'
import { getLink } from '../store/links.js'
import type { SyncContext } from '../sync/context.js'
import { entityTypeOfQbo, notify } from '../sync/intake.js'
import { resolveConflict } from '../sync/resolve.js'

const SYSTEMS: System[] = ['invoicing', 'qbo']
const JOB_STATUSES: JobStatus[] = ['pending', 'running', 'done', 'failed']

const RESOLVE_REFUSALS = {
  not_open: 'The issue is already resolved',
  not_conflict: 'Only a conflict can be resolved by picking a side',
  cannot_restore: 'The other side is deleted or voided and cannot take this version',
} as const

const error = (code: string, message: string) => ({ error: { code, message } })

export type SyncServer = FastifyInstance<Server, IncomingMessage, ServerResponse, Logger>

export function buildServer(ctx: SyncContext): SyncServer {
  const app = Fastify({ loggerInstance: ctx.log })

  app.setErrorHandler((err: FastifyError, _req, reply) => {
    const status = err.statusCode ?? 500
    if (status >= 500) ctx.log.error({ err }, 'request failed')
    return reply
      .status(status)
      .send(
        status >= 500
          ? error('internal_error', 'internal error')
          : error('bad_request', err.message)
      )
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
      let payload: QboWebhookPayload
      try {
        payload = JSON.parse(raw) as QboWebhookPayload
      } catch {
        return reply.status(400).send(error('bad_request', 'Body is not valid JSON'))
      }
      if (!Array.isArray(payload?.eventNotifications)) {
        return reply.status(400).send(error('bad_request', 'Missing eventNotifications'))
      }
      for (const notification of payload.eventNotifications) {
        for (const entity of notification.dataChangeEvent.entities) {
          const entityType = entityTypeOfQbo(entity.name)
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
            entityType: { enum: [...ENTITY_TYPES] },
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
            entityType: { enum: [...ENTITY_TYPES] },
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

  app.patch<{ Params: { id: string }; Body: { resolution: System } }>(
    '/issues/:id',
    {
      schema: {
        params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
        body: {
          type: 'object',
          required: ['resolution'],
          properties: { resolution: { enum: SYSTEMS } },
        },
      },
    },
    async (req, reply) => {
      const outcome = await resolveConflict(ctx, req.params.id, req.body.resolution)
      if (outcome === 'resolved') return { data: await getIssue(ctx.db, req.params.id) }
      if (outcome === 'not_found') {
        return reply.status(404).send(error('not_found', 'No such issue'))
      }
      return reply.status(409).send(error(outcome, RESOLVE_REFUSALS[outcome]))
    }
  )

  app.get<{ Querystring: { status?: JobStatus } }>(
    '/jobs',
    {
      schema: {
        querystring: { type: 'object', properties: { status: { enum: JOB_STATUSES } } },
      },
    },
    async (req) => ({ data: await listJobs(ctx.db, { status: req.query.status }) })
  )

  app.patch<{ Params: { id: string }; Body: { status: 'pending' } }>(
    '/jobs/:id',
    {
      schema: {
        params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
        body: {
          type: 'object',
          required: ['status'],
          properties: { status: { enum: ['pending'] } },
        },
      },
    },
    async (req, reply) => {
      const outcome = await requeueJob(ctx.db, req.params.id, ctx.clock.now())
      if (outcome === 'requeued') return { data: await getJob(ctx.db, req.params.id) }
      if (outcome === 'not_found') return reply.status(404).send(error('not_found', 'No such job'))
      return reply
        .status(409)
        .send(
          error(
            outcome,
            outcome === 'not_failed'
              ? 'Only a failed job can be retried'
              : 'The record already has a pending job'
          )
        )
    }
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
