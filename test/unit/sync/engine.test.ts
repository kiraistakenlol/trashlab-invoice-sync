import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reconcile } from '../../../src/sync/engine.js'
import { resolveConflict } from '../../../src/sync/resolve.js'
import { BlockedError } from '../../../src/sync/errors.js'
import { createWorld, type World } from '../../harness/world.js'

// runs once right after a lookup of open issues finds some, before the caller acts on them
const afterOpenIssues = vi.hoisted(() => ({ fn: null as null | (() => Promise<void>) }))
vi.mock('../../../src/store/issues.js', async (load) => {
  const actual = await load<typeof import('../../../src/store/issues.js')>()
  return {
    ...actual,
    openIssues: async (...args: Parameters<typeof actual.openIssues>) => {
      const found = await actual.openIssues(...args)
      const fn = afterOpenIssues.fn
      if (fn && found.length > 0) {
        afterOpenIssues.fn = null
        await fn()
      }
      return found
    },
  }
})

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

const RETRY_LATER = 10 * 60_000

const qboCustomers = async () => {
  const res = await w.qbo.query('select * from Customer')
  return (
    (res.body as { QueryResponse: { Customer?: { DisplayName: string }[] } }).QueryResponse
      .Customer ?? []
  )
}

const written = async (system: 'invoicing' | 'qbo', entityType: 'customer', id: string) =>
  (await w.history(system, entityType, id)).filter(
    (e) => (e.action === 'created' || e.action === 'updated') && e.error === null
  )

describe('reconcile after a lost create', () => {
  it('a QBO create replayed after a rename ends with the new name, created once', async () => {
    // Given the QBO create times out after the write, and its webhook is lost
    const customer = await w.invoicing.createCustomer({ name: 'Acme' }, 'k-acme')
    w.qbo.failNext({ method: 'POST', path: '/customer' }, 'timeout_after_write')
    await w.deliver()
    await w.drain()
    w.qbo.takeWebhooks()
    // When the source is renamed before the retry
    await w.invoicing.updateCustomer(customer.id, { name: 'Acme Corp' }, 1)
    await w.clock.advance(RETRY_LATER)
    await w.sync()
    // Then
    expect((await qboCustomers()).map((c) => c.DisplayName)).toEqual(['Acme Corp'])
    const qboId = (await w.linkOf('customer', 'invoicing', customer.id))!.qboId!
    expect((await written('qbo', 'customer', qboId)).map((e) => [e.action, e.changes])).toEqual([
      [
        'created',
        {
          name: { from: null, to: 'Acme', source: 'invoicing' },
          active: { from: null, to: true, source: 'invoicing' },
        },
      ],
      ['updated', { name: { from: 'Acme', to: 'Acme Corp', source: 'invoicing' } }],
    ])
    expect(await w.issues()).toEqual([])
  })

  it('an invoicing create replayed after a rename in QBO ends with the new name', async () => {
    // Given the invoicing create times out after the write, and its webhook is lost
    const qboCustomer = await w.qboActor.createCustomer('Beta')
    w.invoicing.failNext('createCustomer', 'timeout_after_write')
    await w.deliver()
    await w.drain()
    w.invoicing.takeWebhooks()
    // When the source is renamed before the retry
    await renameInQbo(qboCustomer.Id, 'Beta Corp')
    await w.clock.advance(RETRY_LATER)
    await w.sync()
    // Then
    const customers = await w.invoicing.listCustomers()
    expect(customers.map((c) => c.name)).toEqual(['Beta Corp'])
    const history = await w.history('qbo', 'customer', qboCustomer.Id)
    expect(history.filter((e) => e.error !== null).map((e) => [e.action, e.error])).toEqual([
      ['created', 'The operation was aborted due to timeout'],
      ['attempt_failed', 'The operation was aborted due to timeout'],
    ])
    expect((await written('invoicing', 'customer', customers[0]!.id)).map((e) => e.action)).toEqual(
      ['created', 'updated']
    )
  })

  it("adopts the in-flight create when the new record's webhook runs before the retry", async () => {
    // Given
    const customer = await w.invoicing.createCustomer({ name: 'Acme' }, 'k-acme')
    w.qbo.failNext({ method: 'POST', path: '/customer' }, 'timeout_after_write')
    // When the QBO webhook of the created record is processed, then the retry runs
    await w.sync()
    await w.clock.advance(RETRY_LATER)
    await w.sync()
    // Then
    const [qboCustomer, ...more] = await qboCustomers()
    expect(more).toEqual([])
    expect(await w.invoicing.listCustomers()).toHaveLength(1)
    const link = (await w.linkOf('customer', 'invoicing', customer.id))!
    const qboId = (qboCustomer as unknown as { Id: string }).Id
    expect(link.qboId).toBe(qboId)
    expect((await w.history('qbo', 'customer', qboId)).map((e) => e.action)).toContain('linked')
    expect(await w.issues()).toEqual([])
  })
})

describe('reconcile of unlinked records', () => {
  const ref = (
    system: 'invoicing' | 'qbo',
    entityType: 'customer' | 'item' | 'account',
    id: string
  ) => ({ system, entityType, entityId: id }) as const

  it('flags a match that is already linked to another record', async () => {
    // Given 'Acme' is linked, then renamed in invoicing without a sync, and a new 'Acme' appears
    const first = await w.invoicing.createCustomer({ name: 'Acme' }, 'k-1')
    await w.sync()
    const link = (await w.linkOf('customer', 'invoicing', first.id))!
    await w.invoicing.updateCustomer(first.id, { name: 'Old Acme' }, 1)
    const second = await w.invoicing.createCustomer({ name: 'Acme' }, 'k-2')
    // When
    await reconcile(w.ctx, ref('invoicing', 'customer', second.id))
    // Then
    expect(await w.linkOf('customer', 'invoicing', second.id)).toBeNull()
    expect(await w.issues()).toMatchObject([
      {
        kind: 'ambiguous_match',
        linkId: null,
        ref: ref('invoicing', 'customer', second.id),
        details: { reason: 'candidate already linked', candidate: link.qboId, linkId: link.id },
      },
    ])
  })

  it('resolves an issue raised before the link once the record links', async () => {
    // Given an inventory item, which is unsupported (the fake lets its type change later)
    const created = await w.ctx.qbo.create(
      'Item',
      { Name: 'Bins', Type: 'Inventory', IncomeAccountRef: { value: '1' } },
      'k-bins'
    )
    await reconcile(w.ctx, ref('qbo', 'item', created.Id))
    const [issue] = await w.issues()
    expect(issue).toMatchObject({ kind: 'unsupported', linkId: null, resolvedAt: null })
    // When it becomes a service item
    await w.ctx.qbo.update('Item', {
      Id: created.Id,
      SyncToken: created.SyncToken,
      Type: 'Service',
    })
    await reconcile(w.ctx, ref('qbo', 'item', created.Id))
    // Then
    expect(await w.issues()).toMatchObject([{ id: issue!.id, resolution: 'converged' }])
    expect((await w.history('qbo', 'item', created.Id)).map((e) => e.action)).toContain(
      'issue_resolved'
    )
    expect((await w.invoicing.listItems()).map((i) => i.name)).toEqual(['Bins'])
  })

  it('is blocked when a referenced account cannot be linked', async () => {
    // Given a QBO item posting to a balance-sheet account, which is not synced
    const created = await w.ctx.qbo.create(
      'Item',
      { Name: 'Deposit', Type: 'Service', IncomeAccountRef: { value: '4' } },
      'k-deposit'
    )
    // When / Then
    await expect(reconcile(w.ctx, ref('qbo', 'item', created.Id))).rejects.toBeInstanceOf(
      BlockedError
    )
    expect(await w.linkOf('item', 'qbo', created.Id)).toBeNull()
    expect(await w.invoicing.listItems()).toEqual([])
  })

  it('ignores a QBO account that is not an income account', async () => {
    // When
    await reconcile(w.ctx, ref('qbo', 'account', '84'))
    // Then
    const [entry, ...rest] = await w.history('qbo', 'account', '84')
    expect(rest).toEqual([])
    expect(entry).toMatchObject({
      action: 'no_change',
      details: { ignored: 'not an income account' },
    })
    expect(await w.linkOf('account', 'qbo', '84')).toBeNull()
  })

  it('a parked job leaves an issue resolved while it ran resolved, and opens none', async () => {
    // Given a conflict on a customer, and a further rename in invoicing
    const customer = await w.invoicing.createCustomer({ name: 'Acme' }, 'k-acme')
    await w.sync()
    const qboId = (await w.linkOf('customer', 'invoicing', customer.id))!.qboId!
    await renameInQbo(qboId, 'Acme QBO')
    await w.invoicing.updateCustomer(customer.id, { name: 'Acme Inv' }, 1)
    await w.sync()
    const [issue] = await w.issues()
    await w.invoicing.updateCustomer(customer.id, { name: 'Acme Inv 2' }, 2)
    // When the operator resolves it after the parked job has read it as open
    afterOpenIssues.fn = async () => {
      expect(await resolveConflict(w.ctx, issue!.id, 'qbo')).toBe('resolved')
    }
    await w.sync()
    // Then the resolution stands and the job it queued copies QBO's name
    expect(afterOpenIssues.fn).toBeNull()
    expect(await w.issues()).toMatchObject([{ id: issue!.id, resolution: 'qbo' }])
    expect((await w.invoicing.getCustomer(customer.id))!.name).toBe('Acme QBO')
  })
})
