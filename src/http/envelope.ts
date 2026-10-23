// The server type, route options and error envelope the HTTP routes share.
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { FastifyInstance } from 'fastify'
import type { Logger } from 'pino'
import type { SyncContext } from '../sync/context.js'

export type SyncServer = FastifyInstance<Server, IncomingMessage, ServerResponse, Logger>

export interface RouteOptions {
  ctx: SyncContext
}

export const errorBody = (code: string, message: string) => ({ error: { code, message } })
