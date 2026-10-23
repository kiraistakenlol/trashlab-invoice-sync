// The operator API: audit history, issues and their resolution, jobs and links.
import type { FastifyReply } from 'fastify'
import { NoResultError } from 'kysely'
import { ENTITY_TYPES, type EntityType, type JobStatus, type System } from '../db/database.js'
import { auditHistory } from '../store/audit.js'
import { getIssue, listIssues } from '../store/issues.js'
import { getJob, listJobs, requeueJob } from '../store/jobs.js'
import { getLink } from '../store/links.js'
import type { SyncContext } from '../sync/context.js'
import { resolveConflict } from '../sync/resolve.js'
import { errorBody, type RouteOptions, type SyncServer } from './envelope.js'

const SYSTEMS: System[] = ['invoicing', 'qbo']
const JOB_STATUSES: JobStatus[] = ['pending', 'running', 'done', 'failed']

const RESOLVE_REFUSALS = {
  not_open: 'The issue is already resolved',
  not_conflict: 'Only a conflict can be resolved by picking a side',
  not_paired: 'The record has no counterpart yet; fix the data and the issue closes by itself',
  blocked:
    'A write this conflict holds back cannot go ahead; fix the data and the issue closes by itself',
  cannot_restore: 'The other side is deleted or voided and cannot take this version',
} as const

const REQUEUE_REFUSALS = {
  not_failed: 'Only a failed job can be retried',
  already_pending: 'The record already has a pending job',
} as const

const idParams = { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } }

const auditSchema = {
  querystring: {
    type: 'object',
    required: ['system', 'entityType', 'entityId'],
    properties: {
      system: { enum: SYSTEMS },
      entityType: { enum: [...ENTITY_TYPES] },
      entityId: { type: 'string' },
    },
  },
}

const listIssuesSchema = {
  querystring: { type: 'object', properties: { open: { type: 'boolean' } } },
}

const resolveIssueSchema = {
  params: idParams,
  body: {
    type: 'object',
    required: ['resolution'],
    properties: { resolution: { enum: SYSTEMS } },
  },
}

const listJobsSchema = {
  querystring: { type: 'object', properties: { status: { enum: JOB_STATUSES } } },
}

const requeueJobSchema = {
  params: idParams,
  body: {
    type: 'object',
    required: ['status'],
    properties: { status: { enum: ['pending'] } },
  },
}

async function resolveIssue(ctx: SyncContext, id: string, side: System, reply: FastifyReply) {
  const outcome = await resolveConflict(ctx, id, side)
  if (outcome === 'resolved') {
    return { data: await getIssue(ctx.db, id) }
  }
  if (outcome === 'not_found') {
    return reply.status(404).send(errorBody('not_found', 'No such issue'))
  }
  return reply.status(409).send(errorBody(outcome, RESOLVE_REFUSALS[outcome]))
}

async function requeue(ctx: SyncContext, id: string, reply: FastifyReply) {
  const outcome = await requeueJob(ctx.db, id, ctx.clock.now())
  if (outcome === 'requeued') {
    return { data: await getJob(ctx.db, id) }
  }
  if (outcome === 'not_found') {
    return reply.status(404).send(errorBody('not_found', 'No such job'))
  }
  return reply.status(409).send(errorBody(outcome, REQUEUE_REFUSALS[outcome]))
}

async function findLink(ctx: SyncContext, id: string, reply: FastifyReply) {
  try {
    return { data: await getLink(ctx.db, id) }
  } catch (e) {
    if (e instanceof NoResultError) {
      return reply.status(404).send(errorBody('not_found', 'No such link'))
    }
    throw e
  }
}

export async function operatorRoutes(app: SyncServer, { ctx }: RouteOptions): Promise<void> {
  app.get<{ Querystring: { system: System; entityType: EntityType; entityId: string } }>(
    '/audit',
    { schema: auditSchema },
    async (req) => {
      const { system, entityType, entityId } = req.query
      return { data: await auditHistory(ctx.db, { system, entityType, entityId }) }
    }
  )
  app.get<{ Querystring: { open?: boolean } }>(
    '/issues',
    { schema: listIssuesSchema },
    async (req) => ({ data: await listIssues(ctx.db, { open: req.query.open }) })
  )
  app.patch<{ Params: { id: string }; Body: { resolution: System } }>(
    '/issues/:id',
    { schema: resolveIssueSchema },
    (req, reply) => resolveIssue(ctx, req.params.id, req.body.resolution, reply)
  )
  app.get<{ Querystring: { status?: JobStatus } }>(
    '/jobs',
    { schema: listJobsSchema },
    async (req) => ({ data: await listJobs(ctx.db, { status: req.query.status }) })
  )
  app.patch<{ Params: { id: string }; Body: { status: 'pending' } }>(
    '/jobs/:id',
    { schema: requeueJobSchema },
    (req, reply) => requeue(ctx, req.params.id, reply)
  )
  app.get<{ Params: { id: string } }>(
    '/links/:id',
    { schema: { params: idParams } },
    (req, reply) => findLink(ctx, req.params.id, reply)
  )
}
