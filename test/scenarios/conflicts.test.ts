// Edits of one invoice in both systems (SCENARIOS.md F1, F5).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { System } from '../../src/db/database.js'
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
