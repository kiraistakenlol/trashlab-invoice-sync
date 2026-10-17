import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { reconcile } from '../../../src/sync/engine.js'
import { createWorld, type World } from '../../harness/world.js'

let w: World
beforeEach(async () => {
  w = await createWorld()
})
afterEach(() => w.close())

const actions = async (system: 'invoicing' | 'qbo', entityType: 'customer', id: string) =>
  (await w.history(system, entityType, id)).map((e) => e.action)

const renameInQbo = async (id: string, name: string) => {
  const current = (await w.qboActor.get('Customer', id))!
  await w.ctx.qbo.update('Customer', { Id: id, SyncToken: current.SyncToken, DisplayName: name })
}

describe('reconcile', () => {
  it('creates a customer from invoicing in QBO once and links the pair', async () => {
    // Given
    const customer = await w.invoicing.createCustomer({ name: 'Acme' }, 'k-acme')
    // When
    await w.sync()
    // Then
    const link = (await w.linkOf('customer', 'invoicing', customer.id))!
    expect(link.qboId).not.toBeNull()
    const qbo = (await w.qboActor.get('Customer', link.qboId!))!
    expect(qbo.DisplayName).toBe('Acme')
    const created = (await w.history('qbo', 'customer', link.qboId!)).filter(
      (e) => e.action === 'created'
    )
    expect(created).toHaveLength(1)
    expect(created[0]!.jobId).not.toBeNull()
    expect(created[0]!.changes).toEqual({
      name: { from: null, to: 'Acme', source: 'invoicing' },
      active: { from: null, to: true, source: 'invoicing' },
    })

    // When reconciled again
    await reconcile(w.ctx, { system: 'invoicing', entityType: 'customer', entityId: customer.id })
    // Then nothing is written
    expect((await w.qboActor.get('Customer', link.qboId!))!.SyncToken).toBe(qbo.SyncToken)
    expect((await actions('invoicing', 'customer', customer.id)).at(-1)).toBe('no_change')
  })

  it('copies a rename in QBO to invoicing', async () => {
    // Given
    const customer = await w.invoicing.createCustomer({ name: 'Acme' }, 'k-acme')
    await w.sync()
    const qboId = (await w.linkOf('customer', 'invoicing', customer.id))!.qboId!
    // When
    await renameInQbo(qboId, 'Acme Corp')
    await w.sync()
    // Then
    expect((await w.invoicing.getCustomer(customer.id))!.name).toBe('Acme Corp')
    const updated = (await w.history('invoicing', 'customer', customer.id)).find(
      (e) => e.action === 'updated'
    )
    expect(updated?.changes).toEqual({ name: { from: 'Acme', to: 'Acme Corp', source: 'qbo' } })
    expect(await w.issues()).toEqual([])
  })

  it('flags different renames on both sides, then resolves the issue once they agree', async () => {
    // Given
    const customer = await w.invoicing.createCustomer({ name: 'Acme' }, 'k-acme')
    await w.sync()
    const link = (await w.linkOf('customer', 'invoicing', customer.id))!
    const qboId = link.qboId!
    // When
    await renameInQbo(qboId, 'Acme QBO')
    const qboToken = (await w.qboActor.get('Customer', qboId))!.SyncToken
    const renamed = await w.invoicing.updateCustomer(customer.id, { name: 'Acme Inv' }, 1)
    await w.sync()
    // Then
    const [issue, ...rest] = await w.issues()
    expect(rest).toEqual([])
    expect(issue).toMatchObject({
      kind: 'conflict',
      linkId: link.id,
      resolvedAt: null,
      details: {
        conflicts: [{ field: 'name', snapshot: 'Acme', invoicing: 'Acme Inv', qbo: 'Acme QBO' }],
      },
    })
    expect((await w.qboActor.get('Customer', qboId))!.SyncToken).toBe(qboToken)
    expect((await w.invoicing.getCustomer(customer.id))!.version).toBe(renamed.version)

    // When both are renamed to the same name
    await renameInQbo(qboId, 'Acme Final')
    await w.invoicing.updateCustomer(customer.id, { name: 'Acme Final' }, renamed.version)
    await w.sync()
    // Then
    const [resolved] = await w.issues()
    expect(resolved).toMatchObject({ id: issue!.id, resolution: 'converged' })
    expect(resolved!.resolvedAt).not.toBeNull()
    expect(Number((await w.qboActor.get('Customer', qboId))!.SyncToken)).toBe(Number(qboToken) + 1)
    const ref = issue!.ref
    expect(
      (await w.history(ref.system, ref.entityType, ref.entityId)).map((e) => e.action)
    ).toContain('issue_resolved')
  })

  it('audits a failed write with its error and creates once on the retry', async () => {
    // Given
    const customer = await w.invoicing.createCustomer({ name: 'Acme' }, 'k-acme')
    w.qbo.failNext({ method: 'POST', path: '/customer' }, 'http_500')
    const ref = { system: 'invoicing', entityType: 'customer', entityId: customer.id } as const
    // When
    await expect(reconcile(w.ctx, ref)).rejects.toThrow('QBO 500')
    await reconcile(w.ctx, ref)
    // Then
    const entries = await w.history('invoicing', 'customer', customer.id)
    expect(entries.find((e) => e.action === 'created')?.error).toContain('QBO 500')
    const res = await w.qbo.query("select * from Customer where DisplayName = 'Acme'")
    expect(
      (res.body as { QueryResponse: { Customer: unknown[] } }).QueryResponse.Customer
    ).toHaveLength(1)
  })

  it('reconciles again after a stale write and finds the sides agreeing', async () => {
    // Given
    const customer = await w.invoicing.createCustomer({ name: 'Acme' }, 'k-acme')
    await w.sync()
    const qboId = (await w.linkOf('customer', 'invoicing', customer.id))!.qboId!
    await w.invoicing.updateCustomer(customer.id, { name: 'Acme Corp' }, 1)
    // When QBO is renamed the same way just before the sync writes
    w.hook(
      'qbo',
      { method: 'POST', path: '/customer' },
      () => renameInQbo(qboId, 'Acme Corp'),
      'before'
    )
    await w.sync()
    // Then
    const entries = await w.history('qbo', 'customer', qboId)
    expect(entries.find((e) => e.action === 'updated')?.error).toContain('5010')
    expect(entries.filter((e) => e.action === 'updated' && e.error === null)).toEqual([])
    expect(await w.issues()).toEqual([])
    const link = (await w.linkOf('customer', 'invoicing', customer.id))!
    expect(link.snapshot).toEqual({ name: 'Acme Corp', active: true })
    expect(link.qboSyncToken).toBe((await w.qboActor.get('Customer', qboId))!.SyncToken)
  })
})
