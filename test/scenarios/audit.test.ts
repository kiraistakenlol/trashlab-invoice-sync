// The audit trail of one invoice, read back through the API (SCENARIOS.md A1).
import { afterEach, describe, expect, it } from 'vitest'
import type { System } from '../../src/db/database.js'
import type { AuditRow } from '../../src/store/audit.js'
import { createWorld, type World } from '../harness/world.js'
import { editInvoice, qboLine, twoLineInvoice } from './given.js'

const PAST_BACKOFF_MS = 1_000
const MEMO = 'Gate code 1234'

let w: World
afterEach(() => w.close())

async function auditOf(system: System, entityId: string): Promise<AuditRow[]> {
  const res = await w.server.inject({
    method: 'GET',
    url: '/audit',
    query: { system, entityType: 'invoice', entityId },
  })
  expect(res.statusCode).toBe(200)
  return (res.json() as { data: AuditRow[] }).data
}

describe('A1 the history of one invoice explains itself', () => {
  it('records the create, an edit retried after a 500, and a conflict', async () => {
    // Given an invoice created in invoicing and synced
    w = await createWorld()
    const given = await twoLineInvoice(w)
    const { invoice, qboId } = given
    // and edited in invoicing, the first copy to QBO failing with a 500
    await editInvoice(w, invoice.id, { memo: MEMO })
    w.qbo.failNext({ method: 'POST', path: '/invoice' }, 'http_500')
    await w.sync()
    w.clock.advance(PAST_BACKOFF_MS)
    await w.sync()
    // and then its lines edited differently in both systems, QBO's notification first
    const qbo = await w.qboActor.updateInvoice(qboId, {
      Line: [qboLine(given.pickup.qboId, 2, 50, 100), qboLine(given.disposal.qboId, 2, 30, 60)],
    })
    await w.deliver()
    const [pickupLine] = (await w.invoicing.getInvoice(invoice.id))!.lines
    const edited = await editInvoice(w, invoice.id, { lines: [pickupLine!] })
    await w.sync()

    // When
    const invoicingHistory = await auditOf('invoicing', invoice.id)
    const qboHistory = await auditOf('qbo', qboId)

    // Then each record holds what was seen of it and what was written to it
    expect(invoicingHistory.map((e) => e.action)).toEqual([
      'notification_received', // created
      'notification_received', // memo edited
      'notification_received', // lines edited
      'no_change', // parked behind the conflict QBO's job opened
    ])
    expect(qboHistory.map((e) => e.action)).toEqual([
      'created', // copied from invoicing
      'notification_received', // echo of the create
      'no_change',
      'updated', // memo copy failed with a 500
      'updated', // memo copy retried
      'notification_received', // echo of the update
      'no_change',
      'notification_received', // lines edited in QBO
      'issue_opened',
    ])

    const [issue, ...more] = await w.issues()
    expect(more).toEqual([])
    expect(invoicingHistory).toMatchObject([
      { details: { kind: 'created', version: 1 } },
      { details: { kind: 'updated', version: 2 } },
      { details: { kind: 'updated', version: edited.version } },
      { details: { parked: issue!.id } },
    ])
    const [created, , , failed, retried, , , , opened] = qboHistory
    expect(created).toMatchObject({
      error: null,
      changes: { number: { from: null, to: invoice.number, source: 'invoicing' } },
    })
    for (const updated of [failed, retried]) {
      expect(updated!.changes).toEqual({ memo: { from: null, to: MEMO, source: 'invoicing' } })
    }
    expect(failed!.error).toMatch(/QBO 500/)
    expect(retried!.error).toBeNull()
    expect(retried!.jobId).toBe(failed!.jobId)
    expect(opened).toMatchObject({ error: null, details: { kind: 'conflict', issueId: issue!.id } })
    expect(issue).toMatchObject({
      kind: 'conflict',
      ref: { system: 'qbo', entityId: qboId },
      details: {
        conflicts: [
          {
            field: 'lines',
            invoicing: [{ quantity: '2', amount: '100.00' }],
            qbo: [{ amount: '100.00' }, { quantity: '2', amount: '60.00' }],
          },
        ],
        versions: { invoicing: String(edited.version), qbo: qbo.SyncToken },
      },
    })
  })
})
