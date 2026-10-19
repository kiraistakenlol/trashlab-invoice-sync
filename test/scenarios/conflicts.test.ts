// Edits of one invoice in both systems (SCENARIOS.md F1, F4, F5).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { IssueResolution, System } from '../../src/db/database.js'
import { notify } from '../../src/sync/intake.js'
import { createWorld, type World } from '../harness/world.js'
import { editInvoice, qboLine, twoLineInvoice, type TwoLineInvoice } from './given.js'

const NEW_DUE_DATE = '2026-03-01'

let w: World
let given: TwoLineInvoice
beforeEach(async () => {
  w = await createWorld()
  given = await twoLineInvoice(w)
})
afterEach(() => w.close())

const actions = async (system: System, id: string) =>
  (await w.history(system, 'invoice', id)).map((e) => e.action)

const qboInvoice = async () => (await w.qboActor.get('Invoice', given.qboId))!
const invoice = async () => (await w.invoicing.getInvoice(given.invoice.id))!

// both sides edit the lines differently: invoicing drops the disposal line, QBO doubles it
async function conflictingLines() {
  const [pickupLine] = (await invoice()).lines
  const edited = await editInvoice(w, given.invoice.id, { lines: [pickupLine!] })
  const qbo = await w.qboActor.updateInvoice(given.qboId, {
    Line: [qboLine(given.pickup.qboId, 2, 50, 100), qboLine(given.disposal.qboId, 2, 30, 60)],
  })
  await w.sync()
  return { edited, qbo }
}

describe('F1 both systems edit different fields', () => {
  it('merges the memo from invoicing and the due date from QBO', async () => {
    // Given
    await editInvoice(w, given.invoice.id, { memo: 'Gate code 1234' })
    await w.qboActor.updateInvoice(given.qboId, { DueDate: NEW_DUE_DATE })
    // When
    await w.sync()
    // Then
    expect(await invoice()).toMatchObject({ memo: 'Gate code 1234', dueDate: NEW_DUE_DATE })
    expect(await qboInvoice()).toMatchObject({
      CustomerMemo: { value: 'Gate code 1234' },
      DueDate: NEW_DUE_DATE,
    })
    const updated = async (system: System, id: string) =>
      (await w.history(system, 'invoice', id)).filter((e) => e.action === 'updated')
    expect(await updated('qbo', given.qboId)).toMatchObject([
      { error: null, changes: { memo: { to: 'Gate code 1234', source: 'invoicing' } } },
    ])
    expect(await updated('invoicing', given.invoice.id)).toMatchObject([
      { error: null, changes: { dueDate: { to: NEW_DUE_DATE, source: 'qbo' } } },
    ])
    expect(await w.issues()).toEqual([])
  })
})

const resolve = (issueId: string, resolution: IssueResolution) =>
  w.server.inject({ method: 'PATCH', url: `/issues/${issueId}`, payload: { resolution } })

const openIssueId = async () => (await w.issues()).find((i) => i.resolution === null)!.id

const writes = async () =>
  [
    ...(await w.history('invoicing', 'invoice', given.invoice.id)),
    ...(await w.history('qbo', 'invoice', given.qboId)),
  ].filter((e) => ['updated', 'voided', 'deleted'].includes(e.action))

// both systems' notifications came and went; the pair is reconciled once more
async function syncAgainWritesNothing() {
  const before = await writes()
  await notify(
    w.ctx,
    { system: 'invoicing', entityType: 'invoice', entityId: given.invoice.id },
    {}
  )
  await notify(w.ctx, { system: 'qbo', entityType: 'invoice', entityId: given.qboId }, {})
  await w.sync()
  expect(await writes()).toEqual(before)
}

describe('F4 resolving a conflict', () => {
  it('resolved to qbo: invoicing gets the lines from QBO and the issue closes', async () => {
    // Given
    const { qbo } = await conflictingLines()
    const issueId = await openIssueId()
    // When
    const res = await resolve(issueId, 'qbo')
    await w.sync()
    // Then
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ data: { id: issueId, resolution: 'qbo' } })
    expect((await invoice()).lines).toMatchObject([
      { itemId: given.pickup.item.id, quantity: '2', amount: '100.00' },
      { itemId: given.disposal.item.id, quantity: '2', amount: '60.00' },
    ])
    expect((await qboInvoice()).SyncToken).toBe(qbo.SyncToken)
    expect(await w.issues()).toMatchObject([{ id: issueId, resolution: 'qbo' }])
    const { ref } = (await w.issues())[0]!
    const resolved = (await w.history(ref.system, 'invoice', ref.entityId)).filter(
      (e) => e.action === 'issue_resolved'
    )
    expect(resolved).toMatchObject([
      { details: { issueId, kind: 'conflict', resolution: 'qbo', by: 'operator' } },
    ])
    await syncAgainWritesNothing()
  })

  it('resolved to invoicing: QBO gets the lines from invoicing', async () => {
    // Given
    const { edited } = await conflictingLines()
    // When
    const res = await resolve(await openIssueId(), 'invoicing')
    await w.sync()
    // Then
    expect(res.statusCode).toBe(200)
    expect(
      (await qboInvoice()).Line.filter((l) => l.DetailType === 'SalesItemLineDetail')
    ).toMatchObject([
      { Amount: 100, SalesItemLineDetail: { ItemRef: { value: given.pickup.qboId } } },
    ])
    expect((await invoice()).version).toBe(edited.version)
    expect(await w.issues()).toMatchObject([{ resolution: 'invoicing' }])
    await syncAgainWritesNothing()
  })

  it('void vs edit resolved to the void: the other side is voided', async () => {
    // Given
    await editInvoice(w, given.invoice.id, { memo: 'Gate code 1234' })
    await w.qboActor.voidInvoice(given.qboId)
    await w.sync()
    // When
    const res = await resolve(await openIssueId(), 'qbo')
    await w.sync()
    // Then
    expect(res.statusCode).toBe(200)
    expect(await invoice()).toMatchObject({ status: 'void' })
    expect(await w.issues()).toMatchObject([{ resolution: 'qbo' }])
    await syncAgainWritesNothing()
  })

  it('void vs edit resolved to the edit: 409 cannot_restore, the issue stays open', async () => {
    // Given
    await editInvoice(w, given.invoice.id, { memo: 'Gate code 1234' })
    await w.qboActor.voidInvoice(given.qboId)
    await w.sync()
    // When
    const res = await resolve(await openIssueId(), 'invoicing')
    // Then
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ error: { code: 'cannot_restore' } })
    expect(await w.issues()).toMatchObject([{ resolution: null }])
  })

  it('deleted in QBO, edited in invoicing, resolved to qbo: invoicing deletes it', async () => {
    // Given
    await editInvoice(w, given.invoice.id, { memo: 'Gate code 1234' })
    await w.qboActor.deleteInvoice(given.qboId)
    await w.sync()
    // When
    const res = await resolve(await openIssueId(), 'qbo')
    await w.sync()
    // Then
    expect(res.statusCode).toBe(200)
    expect((await invoice()).deletedAt).not.toBeNull()
    expect((await w.linkOf('invoice', 'qbo', given.qboId))!.deletedAt).not.toBeNull()
    expect(await w.issues()).toMatchObject([{ resolution: 'qbo' }])
  })

  it('deleted in QBO, resolved to invoicing: 409 cannot_restore, the issue stays open', async () => {
    // Given
    const edited = await editInvoice(w, given.invoice.id, { memo: 'Gate code 1234' })
    await w.qboActor.deleteInvoice(given.qboId)
    await w.sync()
    // When
    const res = await resolve(await openIssueId(), 'invoicing')
    await w.sync()
    // Then
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ error: { code: 'cannot_restore' } })
    expect(await w.issues()).toMatchObject([{ resolution: null }])
    expect(await invoice()).toMatchObject({ version: edited.version, deletedAt: null })
  })

  it('deleted in QBO, voided in invoicing, resolved to qbo: invoicing deletes it', async () => {
    // Given
    await w.invoicing.voidInvoice(given.invoice.id, given.invoice.version)
    await w.qboActor.deleteInvoice(given.qboId)
    await w.sync()
    // When
    const res = await resolve(await openIssueId(), 'qbo')
    await w.sync()
    // Then
    expect(res.statusCode).toBe(200)
    expect((await invoice()).deletedAt).not.toBeNull()
    expect(await w.issues()).toMatchObject([{ resolution: 'qbo' }])
    const before = await writes()
    await notify(
      w.ctx,
      { system: 'invoicing', entityType: 'invoice', entityId: given.invoice.id },
      {}
    )
    await w.sync()
    expect(await writes()).toEqual(before)
  })

  it('a loser edited again before the job: a new conflict, neither side overwritten', async () => {
    // Given
    const { qbo } = await conflictingLines()
    const issueId = await openIssueId()
    await resolve(issueId, 'qbo')
    // When invoicing, the losing side, edits the lines again before the job runs
    const again = await editInvoice(w, given.invoice.id, {
      lines: [
        { itemId: given.pickup.item.id, quantity: '3', unitPrice: '50.00', amount: '150.00' },
      ],
    })
    await w.sync()
    // Then
    expect(await w.issues()).toMatchObject([
      { id: issueId, resolution: 'qbo' },
      { kind: 'conflict', resolution: null },
    ])
    expect((await invoice()).version).toBe(again.version)
    expect((await qboInvoice()).SyncToken).toBe(qbo.SyncToken)
  })
})

describe('F5 a conflicted invoice stays parked', () => {
  it('records further edits without applying them, and closes once both sides agree', async () => {
    // Given
    const { qbo } = await conflictingLines()
    // When a further edit arrives
    const edited = await editInvoice(w, given.invoice.id, { memo: 'Gate code 1234' })
    await w.sync()
    // Then it is recorded, not applied
    expect((await qboInvoice()).SyncToken).toBe(qbo.SyncToken)
    const [issue] = await w.issues()
    expect(issue).toMatchObject({
      resolution: null,
      details: { versions: { invoicing: String(edited.version), qbo: qbo.SyncToken } },
    })
    const last = (await w.history('invoicing', 'invoice', given.invoice.id)).at(-1)
    expect(last).toMatchObject({ action: 'no_change', details: { parked: issue!.id } })
    // When both sides are made equal by hand
    const [pickupLine] = (await invoice()).lines
    const settled = await editInvoice(w, given.invoice.id, {
      memo: null,
      lines: [
        pickupLine!,
        { itemId: given.disposal.item.id, quantity: '2', unitPrice: '30.00', amount: '60.00' },
      ],
    })
    await w.sync()
    // Then the issue closes and nothing is written
    expect(await w.issues()).toMatchObject([{ id: issue!.id, resolution: 'converged' }])
    expect((await qboInvoice()).SyncToken).toBe(qbo.SyncToken)
    expect((await invoice()).version).toBe(settled.version)
    expect(await actions('invoicing', given.invoice.id)).toContain('issue_resolved')
  })
})

describe('F3 both systems make the same edit', () => {
  it('raises no conflict and writes nothing', async () => {
    // Given
    const edited = await editInvoice(w, given.invoice.id, { memo: 'Gate code 1234' })
    const qbo = await w.qboActor.updateInvoice(given.qboId, {
      CustomerMemo: { value: 'Gate code 1234' },
    })
    // When
    await w.sync()
    // Then
    expect(await w.issues()).toEqual([])
    expect((await invoice()).version).toBe(edited.version)
    expect((await qboInvoice()).SyncToken).toBe(qbo.SyncToken)
    for (const [system, id] of [
      ['invoicing', given.invoice.id],
      ['qbo', given.qboId],
    ] as const) {
      expect(await actions(system, id)).not.toContain('updated')
    }
  })
})
