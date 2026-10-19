// Existing records with no link (SCENARIOS.md L2-L6) and dependencies created along the way.
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Invoice } from '../../src/invoicing/types.js'
import type { QboEntities } from '../../src/qbo/api.js'
import type { QboInvoice } from '../../src/qbo/entities.js'
import { enqueueAll } from '../../src/sync/reconcile-all.js'
import { createWorld, type World } from '../harness/world.js'
import { DUE_DATE, ISSUE_DATE, linkedCustomer, linkedItem, qboEvents } from './given.js'

let w: World
beforeEach(async () => {
  w = await createWorld()
})
afterEach(() => w.close())

const qboCount = async (entity: keyof QboEntities) => {
  const res = await w.qbo.query(`select * from ${entity}`)
  return ((res.body as { QueryResponse: Record<string, unknown[]> }).QueryResponse[entity] ?? [])
    .length
}

describe('L4 customers and items are matched by name', () => {
  it('links same-named records instead of creating new ones', async () => {
    // Given
    const account = await w.invoicing.createAccount({ name: 'Services' }, 'k-account')
    const item = await w.invoicing.createItem(
      { name: 'Services', incomeAccountId: account.id },
      'k-item'
    )
    const customer = await w.invoicing.createCustomer({ name: 'Acme' }, 'k-customer')
    const qboCustomer = await w.qboActor.createCustomer('ACME')
    const before = { customers: await qboCount('Customer'), items: await qboCount('Item') }
    // When
    await w.sync()
    // Then
    expect(await w.linkOf('account', 'invoicing', account.id)).toMatchObject({ qboId: '1' })
    expect(await w.linkOf('item', 'invoicing', item.id)).toMatchObject({ qboId: '1' })
    const link = await w.linkOf('customer', 'invoicing', customer.id)
    expect(link).toMatchObject({ qboId: qboCustomer.Id })
    expect({ customers: await qboCount('Customer'), items: await qboCount('Item') }).toEqual(before)
    expect(await w.invoicing.listCustomers()).toHaveLength(1)
    expect(await w.invoicing.listItems()).toHaveLength(1)
    expect(await w.invoicing.listAccounts()).toHaveLength(1)
    const histories = [
      ...(await w.history('invoicing', 'customer', customer.id)),
      ...(await w.history('qbo', 'customer', qboCustomer.Id)),
    ]
    expect(histories.filter((e) => e.action === 'linked')).toHaveLength(1)
    // the names differ in case and have no common past, which is flagged, not guessed
    expect(await w.issues()).toMatchObject([
      {
        kind: 'conflict',
        linkId: link!.id,
        details: { conflicts: [{ field: 'name', invoicing: 'Acme', qbo: 'ACME' }] },
      },
    ])
  })
})

describe('C4 an item brings its income account along', () => {
  it('creates the income account in QBO before the item', async () => {
    // Given
    const account = await w.invoicing.createAccount({ name: 'Hauling' }, 'k-account')
    const item = await w.invoicing.createItem(
      { name: 'Pickup', incomeAccountId: account.id },
      'k-item'
    )
    // When
    await w.sync()
    // Then
    const accountId = (await w.linkOf('account', 'invoicing', account.id))!.qboId!
    const itemId = (await w.linkOf('item', 'invoicing', item.id))!.qboId!
    expect(await w.qboActor.get('Account', accountId)).toMatchObject({
      Name: 'Hauling',
      AccountType: 'Income',
    })
    expect(await w.qboActor.get('Item', itemId)).toMatchObject({
      Name: 'Pickup',
      IncomeAccountRef: { value: accountId },
    })
    const createdAt = async (entityType: 'account' | 'item', id: string) =>
      BigInt((await w.history('qbo', entityType, id)).find((e) => e.action === 'created')!.id)
    expect(await createdAt('account', accountId)).toBeLessThan(await createdAt('item', itemId))
    expect(await w.issues()).toEqual([])
  })
})

// The same invoice entered on both sides by hand: number A-100, one 100.00 line.
async function enteredOnBothSides(qbo: { customerName?: string; amount?: string } = {}) {
  const { customer, qboId: customerQboId } = await linkedCustomer(w, 'Acme')
  const { item, qboId: itemQboId } = await linkedItem(w, 'Pickup', 'Hauling')
  const invoice = await w.invoicing.createInvoice(
    {
      number: 'A-100',
      customerId: customer.id,
      issueDate: ISSUE_DATE,
      dueDate: DUE_DATE,
      lines: [{ itemId: item.id, quantity: '1', unitPrice: '100.00', amount: '100.00' }],
    },
    'k-invoice'
  )
  const qboCustomerId = qbo.customerName
    ? (await w.qboActor.createCustomer(qbo.customerName)).Id
    : customerQboId
  const qboInvoice = await w.qboActor.createInvoice(
    qboCustomerId,
    [{ amount: qbo.amount ?? '100.00', itemId: itemQboId }],
    { DocNumber: 'A-100', TxnDate: ISSUE_DATE, DueDate: DUE_DATE }
  )
  return { invoice, qboInvoice }
}

const invoiceCounts = async () => ({
  invoicing: (await w.invoicing.listInvoices()).length,
  qbo: await qboCount('Invoice'),
})

describe('L2 same number, different invoice', () => {
  it.each([
    ['total', { amount: '90.00' }],
    ['customer', { customerName: 'Other Co' }],
  ])('flags the number as taken when the %s differs', async (_field, qbo) => {
    // Given
    const { invoice, qboInvoice } = await enteredOnBothSides(qbo)
    // When
    await w.sync()
    // Then
    expect(await w.linkOf('invoice', 'invoicing', invoice.id)).toBeNull()
    expect(await w.linkOf('invoice', 'qbo', qboInvoice.Id)).toBeNull()
    expect(await invoiceCounts()).toEqual({ invoicing: 1, qbo: 1 })
    const issues = await w.issues()
    expect(issues.map((i) => [i.kind, i.ref.system, i.ref.entityId])).toEqual(
      expect.arrayContaining([
        ['number_taken', 'invoicing', invoice.id],
        ['number_taken', 'qbo', qboInvoice.Id],
      ])
    )
    expect(issues).toHaveLength(2)
    for (const [system, id] of [
      ['invoicing', invoice.id],
      ['qbo', qboInvoice.Id],
    ] as const) {
      const actions = (await w.history(system, 'invoice', id)).map((e) => e.action)
      expect(actions).toContain('issue_opened')
      expect(actions).not.toContain('created')
    }
  })
})

describe('L3 duplicate numbers in QBO', () => {
  it('flags the number as ambiguous and links nothing', async () => {
    // Given the same number twice in QBO and once in invoicing
    const { invoice, qboInvoice } = await enteredOnBothSides()
    const itemQboId = (await w.linkOf('item', 'invoicing', invoice.lines[0]!.itemId))!.qboId!
    const twin = await w.qboActor.createInvoice(
      qboInvoice.CustomerRef.value,
      [{ amount: '100.00', itemId: itemQboId }],
      { DocNumber: 'A-100', TxnDate: ISSUE_DATE, DueDate: DUE_DATE }
    )
    const before = await invoiceCounts()
    // When
    await w.sync()
    // Then
    expect(await w.linkOf('invoice', 'invoicing', invoice.id)).toBeNull()
    expect(await w.linkOf('invoice', 'qbo', qboInvoice.Id)).toBeNull()
    expect(await w.linkOf('invoice', 'qbo', twin.Id)).toBeNull()
    expect(await invoiceCounts()).toEqual(before)
    const issues = await w.issues()
    expect(issues.length).toBeGreaterThan(0)
    for (const issue of issues) expect(issue.kind).toBe('ambiguous_match')
    const fromInvoicing = issues.find((i) => i.ref.system === 'invoicing')!
    expect(fromInvoicing.details).toMatchObject({
      candidates: expect.arrayContaining([qboInvoice.Id, twin.Id]),
    })
  })
})

describe('L5 initial reconciliation', () => {
  it('matches or creates every record that existed before the sync', async () => {
    // Given records on both sides that no notification ever announced
    const account = await w.invoicing.createAccount({ name: 'Services' }, 'k-account')
    const item = await w.invoicing.createItem(
      { name: 'Services', incomeAccountId: account.id },
      'k-item'
    )
    const customer = await w.invoicing.createCustomer({ name: 'Acme' }, 'k-customer')
    const invoiceOf = (number: string, key: string) =>
      w.invoicing.createInvoice(
        {
          number,
          customerId: customer.id,
          issueDate: ISSUE_DATE,
          dueDate: DUE_DATE,
          lines: [{ itemId: item.id, quantity: '1', unitPrice: '100.00', amount: '100.00' }],
        },
        key
      )
    const pair = await invoiceOf('A-100', 'k-pair')
    const lonely = await invoiceOf('B-200', 'k-lonely')
    const qboAcme = await w.qboActor.createCustomer('Acme')
    const qboPair = await w.qboActor.createInvoice(qboAcme.Id, [{ amount: '100.00' }], {
      DocNumber: 'A-100',
      TxnDate: ISSUE_DATE,
      DueDate: DUE_DATE,
    })
    const globex = await w.qboActor.createCustomer('Globex')
    w.qbo.takeWebhooks()
    w.invoicing.takeWebhooks()
    // When
    await enqueueAll(w.ctx)
    await w.sync()
    // Then the pair is linked and each lonely record is created on the other side
    expect(await w.linkOf('invoice', 'invoicing', pair.id)).toMatchObject({ qboId: qboPair.Id })
    expect(await w.linkOf('invoice', 'invoicing', lonely.id)).toMatchObject({
      qboId: expect.any(String),
    })
    expect(await w.linkOf('customer', 'qbo', globex.Id)).toMatchObject({
      invoicingId: expect.any(String),
    })
    expect((await w.invoicing.listCustomers()).map((c) => c.name).sort()).toEqual([
      'Acme',
      'Globex',
    ])
    expect(await invoiceCounts()).toEqual({ invoicing: 2, qbo: 2 })
    expect(await w.issues()).toEqual([])
    // And a second run writes nothing
    const invoicing = await w.invoicing.listInvoices()
    const customers = await w.invoicing.listCustomers()
    await enqueueAll(w.ctx)
    await w.sync()
    expect(await w.invoicing.listInvoices()).toEqual(invoicing)
    expect(await w.invoicing.listCustomers()).toEqual(customers)
    expect(await invoiceCounts()).toEqual({ invoicing: 2, qbo: 2 })
  })
})

// A 40.00 payment of the invoice entered on both sides, recorded by hand on one side.
const paidInInvoicing = (invoice: Invoice, date = ISSUE_DATE) =>
  w.invoicing.createPayment(
    {
      customerId: invoice.customerId,
      amount: '40.00',
      date,
      allocations: [{ invoiceId: invoice.id, amount: '40.00' }],
    },
    randomUUID()
  )
const paidInQbo = (invoice: QboInvoice, date = ISSUE_DATE) =>
  w.qboActor.createPayment(
    invoice.CustomerRef.value,
    '40.00',
    [{ invoiceId: invoice.Id, amount: '40.00' }],
    { TxnDate: date }
  )

const paymentCounts = async () => ({
  invoicing: (await w.invoicing.listPayments()).length,
  qbo: await qboCount('Payment'),
})

describe('L6 payments recorded on both sides are matched', () => {
  it('links the same payment instead of creating it again', async () => {
    // Given
    const { invoice, qboInvoice } = await enteredOnBothSides()
    const payment = await paidInInvoicing(invoice)
    const qboPayment = await paidInQbo(qboInvoice)
    // When
    await w.sync()
    // Then
    expect(await w.linkOf('payment', 'invoicing', payment.id)).toMatchObject({
      qboId: qboPayment.Id,
    })
    expect(await paymentCounts()).toEqual({ invoicing: 1, qbo: 1 })
    expect(await w.issues()).toEqual([])
    const actions = [
      ...(await w.history('invoicing', 'payment', payment.id)),
      ...(await w.history('qbo', 'payment', qboPayment.Id)),
    ].map((e) => e.action)
    expect(actions.filter((a) => a === 'linked')).toHaveLength(1)
    expect(actions).not.toContain('created')
    // And a second run writes nothing
    await enqueueAll(w.ctx)
    await w.sync()
    expect(await w.invoicing.getPayment(payment.id)).toMatchObject({ version: payment.version })
    expect(await w.qboActor.get('Payment', qboPayment.Id)).toMatchObject({
      SyncToken: qboPayment.SyncToken,
    })
  })

  it('pairs off identical payments one to one', async () => {
    // Given the same payment twice on each side
    const { invoice, qboInvoice } = await enteredOnBothSides()
    const payments = [await paidInInvoicing(invoice), await paidInInvoicing(invoice)]
    const qboPayments = [await paidInQbo(qboInvoice), await paidInQbo(qboInvoice)]
    // When
    await w.sync()
    // Then
    const linked = await Promise.all(
      payments.map(async (p) => (await w.linkOf('payment', 'invoicing', p.id))?.qboId)
    )
    expect(linked.sort()).toEqual(qboPayments.map((p) => p.Id).sort())
    expect(await paymentCounts()).toEqual({ invoicing: 2, qbo: 2 })
    expect(await w.issues()).toEqual([])
  })

  it('links a payment entered on another date and flags the date', async () => {
    // Given
    const { invoice, qboInvoice } = await enteredOnBothSides()
    const payment = await paidInInvoicing(invoice)
    const qboPayment = await paidInQbo(qboInvoice, '2026-01-06')
    // When
    await w.sync()
    // Then
    const link = await w.linkOf('payment', 'invoicing', payment.id)
    expect(link).toMatchObject({ qboId: qboPayment.Id })
    expect(await paymentCounts()).toEqual({ invoicing: 1, qbo: 1 })
    expect(await w.issues()).toMatchObject([
      {
        kind: 'conflict',
        linkId: link!.id,
        details: { conflicts: [{ field: 'date', invoicing: ISSUE_DATE, qbo: '2026-01-06' }] },
      },
    ])
  })

  it('flags payments that could match several on other dates, and links nothing', async () => {
    // Given one payment in invoicing and two like it on other dates in QBO
    const { invoice, qboInvoice } = await enteredOnBothSides()
    const payment = await paidInInvoicing(invoice)
    const qboPayments = [
      await paidInQbo(qboInvoice, '2026-01-06'),
      await paidInQbo(qboInvoice, '2026-01-07'),
    ]
    // When
    await w.sync()
    // Then
    expect(await w.linkOf('payment', 'invoicing', payment.id)).toBeNull()
    for (const p of qboPayments) expect(await w.linkOf('payment', 'qbo', p.Id)).toBeNull()
    expect(await paymentCounts()).toEqual({ invoicing: 1, qbo: 2 })
    const issues = await w.issues()
    expect(issues.map((i) => [i.kind, i.ref.system, i.ref.entityId]).sort()).toEqual(
      [
        ['ambiguous_match', 'invoicing', payment.id],
        ...qboPayments.map((p) => ['ambiguous_match', 'qbo', p.Id]),
      ].sort()
    )
    expect(issues.find((i) => i.ref.system === 'invoicing')!.details).toMatchObject({
      candidates: qboPayments.map((p) => p.Id).sort(),
    })
  })

  // found by the property-based invariants (I3)
  it('leaves a create that landed but was not stored to its own link', async () => {
    // Given the first payment's create landed in QBO but timed out, and its notification
    // hasn't arrived yet
    const { invoice } = await enteredOnBothSides()
    await w.sync()
    w.qbo.failNext({ method: 'POST', path: '/payment' }, 'timeout_after_write')
    const first = await paidInInvoicing(invoice)
    await w.deliver({ drop: qboEvents })
    await w.drain()
    // When the same payment is recorded again before the first create is retried
    const second = await paidInInvoicing(invoice)
    await w.deliver({ drop: qboEvents })
    await w.drain()
    await w.clock.advance(60_000)
    await w.sync()
    // Then each payment has its own QBO payment, and a replay writes nothing
    const ids = [
      (await w.linkOf('payment', 'invoicing', first.id))?.qboId,
      (await w.linkOf('payment', 'invoicing', second.id))?.qboId,
    ]
    expect(new Set(ids).size).toBe(2)
    expect(ids).not.toContain(undefined)
    expect(await paymentCounts()).toEqual({ invoicing: 2, qbo: 2 })
    expect(await w.issues()).toEqual([])
    await enqueueAll(w.ctx)
    await w.sync()
    expect(await paymentCounts()).toEqual({ invoicing: 2, qbo: 2 })
  })

  it('creates a second identical payment made after the first was synced', async () => {
    // Given
    const { invoice } = await enteredOnBothSides()
    const first = await paidInInvoicing(invoice)
    await w.sync()
    // When the customer pays the same amount again
    const second = await paidInInvoicing(invoice)
    await w.sync()
    // Then
    const ids = [
      (await w.linkOf('payment', 'invoicing', first.id))?.qboId,
      (await w.linkOf('payment', 'invoicing', second.id))?.qboId,
    ]
    expect(new Set(ids).size).toBe(2)
    expect(await paymentCounts()).toEqual({ invoicing: 2, qbo: 2 })
    expect(await w.issues()).toEqual([])
  })
})
