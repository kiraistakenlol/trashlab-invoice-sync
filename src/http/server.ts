// Fastify app: change-notification intake and the operator API.
import Fastify, { type FastifyError } from 'fastify'
import type { SyncContext } from '../sync/context.js'
import { errorBody, type SyncServer } from './envelope.js'
import { invoicingWebhookRoutes } from './invoicing-webhook.js'
import { operatorRoutes } from './operator-api.js'
import { qboWebhookRoutes } from './qbo-webhook.js'

export type { SyncServer } from './envelope.js'

export function buildServer(ctx: SyncContext): SyncServer {
  // requests are plumbing: the sync logs what it does with them
  const app = Fastify({ loggerInstance: ctx.log, disableRequestLogging: true })

  app.setErrorHandler((err: FastifyError, _req, reply) => {
    const status = err.statusCode ?? 500
    if (status < 500) {
      return reply.status(status).send(errorBody('bad_request', err.message))
    }
    ctx.log.error({ err }, 'request failed')
    return reply.status(status).send(errorBody('internal_error', 'internal error'))
  })
  app.setNotFoundHandler((_req, reply) =>
    reply.status(404).send(errorBody('not_found', 'Not found'))
  )

  app.get('/health', async () => ({ data: { status: 'ok' } }))

  // without a verifier token no delivery can be trusted, so QBO is only polled
  const verifierToken = ctx.config.qboWebhookVerifierToken
  if (verifierToken !== null) {
    app.register(qboWebhookRoutes, { ctx, verifierToken })
  }
  app.register(invoicingWebhookRoutes, { ctx })
  app.register(operatorRoutes, { ctx })
  return app
}
