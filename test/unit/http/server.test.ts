import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { signQboWebhook } from '../../../src/qbo/webhooks.js'
import { createWorld, type World } from '../../harness/world.js'

let w: World
beforeAll(async () => {
  w = await createWorld()
})
afterAll(() => w.close())

const qboBody = (name: string, id: string) =>
  JSON.stringify({
    eventNotifications: [
      {
        realmId: '1',
        dataChangeEvent: {
          entities: [{ name, id, operation: 'Update', lastUpdated: '2026-01-05T10:00:00Z' }],
        },
      },
    ],
  })

const postQbo = (body: string, signature = signQboWebhook(body, 'test-verifier-token')) =>
  w.server.inject({
    method: 'POST',
    url: '/webhooks/qbo',
    payload: body,
    headers: { 'content-type': 'application/json', 'intuit-signature': signature },
  })

const jobs = (entityId: string) =>
  w.db.selectFrom('sync_jobs').selectAll().where('entity_id', '=', entityId).execute()

describe('http server', () => {
  it('answers /health', async () => {
    const res = await w.server.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ data: { status: 'ok' } })
  })

  it('queues one job and one audit entry for a signed QBO webhook', async () => {
    const res = await postQbo(qboBody('Invoice', '1001'))
    expect(res.statusCode).toBe(200)
    expect(await jobs('1001')).toMatchObject([{ system: 'qbo', entity_type: 'invoice' }])
    const history = await w.history('qbo', 'invoice', '1001')
    expect(history).toMatchObject([
      { action: 'notification_received', details: { source: 'webhook', operation: 'Update' } },
    ])
  })

  it('keeps one pending job but audits both deliveries of a duplicate', async () => {
    const body = qboBody('Invoice', '1002')
    await postQbo(body)
    await postQbo(body)
    expect(await jobs('1002')).toHaveLength(1)
    expect(await w.history('qbo', 'invoice', '1002')).toHaveLength(2)
  })

  it('rejects a bad signature and queues nothing', async () => {
    const res = await postQbo(qboBody('Invoice', '1003'), 'bogus')
    expect(res.statusCode).toBe(401)
    expect(res.json()).toMatchObject({ error: { code: 'invalid_signature' } })
    expect(await jobs('1003')).toEqual([])
  })

  it('queues a job for an invoicing event', async () => {
    const res = await w.server.inject({
      method: 'POST',
      url: '/webhooks/invoicing',
      payload: { id: 'e1', entityType: 'invoice', entityId: 'inv-1', kind: 'updated', version: 3 },
    })
    expect(res.statusCode).toBe(200)
    expect(await jobs('inv-1')).toMatchObject([{ system: 'invoicing', entity_type: 'invoice' }])
    expect(await w.history('invoicing', 'invoice', 'inv-1')).toMatchObject([
      { details: { source: 'webhook', kind: 'updated', version: 3 } },
    ])
  })

  it('ignores entity names the sync does not handle', async () => {
    const res = await postQbo(qboBody('Bill', '1004'))
    expect(res.statusCode).toBe(200)
    expect(await jobs('1004')).toEqual([])
  })

  it('serves the audit entries', async () => {
    const res = await w.server.inject({
      method: 'GET',
      url: '/audit?system=qbo&entityType=invoice&entityId=1002',
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toHaveLength(2)
  })

  it('serves open issues and 404s an unknown link', async () => {
    expect((await w.server.inject({ method: 'GET', url: '/issues?open=true' })).json()).toEqual({
      data: [],
    })
    const res = await w.server.inject({
      method: 'GET',
      url: '/links/00000000-0000-0000-0000-000000000000',
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ error: { code: 'not_found' } })
  })
})
