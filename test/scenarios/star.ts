// The ★ scenarios of SCENARIOS.md, run on any scenario world.
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { System } from '../../src/db/database.js'
import type { InvoicingEventKind } from '../../src/invoicing/types.js'
import { timeoutError } from '../fakes/failures.js'
import type { ScenarioWorld } from '../harness/world.js'
import {
  DUE_DATE,
  editInvoice,
  ISSUE_DATE,
  linkedCustomer,
  linkedInvoice,
  linkedItem,
  linkedPayment,
  qboLine,
  twoLineInvoice,
} from './given.js'

const PAST_BACKOFF_MS = 1_000
const NEW_DUE_DATE = '2026-03-01'
// QBO tax codes: the line code and the transaction-level 8 % rate
const LINE_TAXED = 'TAX'
const TXN_TAX_RATE = '2'

export function starScenarios(make: () => Promise<ScenarioWorld>): void {
  let w: ScenarioWorld | undefined
  beforeEach(async () => {
    w = await make()
  })
  afterEach(async () => {
    await w?.close()
    w = undefined
  })
  const world = () => w!

  const history = (system: System, entityType: 'invoice' | 'payment', id: string) =>
    world().history(system, entityType, id)
  const withAction = async (
    system: System,
    entityType: 'invoice' | 'payment',
    id: string,
    actions: string[]
  ) => (await history(system, entityType, id)).filter((e) => actions.includes(e.action))
  const updates = (system: System, id: string) => withAction(system, 'invoice', id, ['updated'])
  const writes = (system: System, id: string) =>
    withAction(system, 'invoice', id, ['updated', 'voided', 'deleted'])
  const actions = async (system: System, id: string) =>
    (await history(system, 'invoice', id)).map((e) => e.action)

  const linkedTo = (entityType: 'invoice' | 'payment', system: System, id: string) => async () =>
    (await world().linkOf(entityType, system, id)) !== null

  // a linked invoice of 1 x 100.00 for a linked customer
  async function invoiceOf100() {
    const w = world()
    const customer = await linkedCustomer(w, 'Acme')
    const item = await linkedItem(w, 'Pickup', 'Hauling')
    const { invoice, qboId } = await linkedInvoice(w, {
      customer: customer.customer,
      lines: [{ itemId: item.item.id, quantity: '1', unitPrice: '100.00', amount: '100.00' }],
    })
    return { customer, item, invoice, qboId }
  }

  // invoicing notifies about its last change to the invoice again; nothing may be written
  async function redeliveryWritesNothing(
    invoiceId: string,
    qboId: string,
    kind: InvoicingEventKind
  ): Promise<void> {
    const w = world()
    const before = [...(await writes('invoicing', invoiceId)), ...(await writes('qbo', qboId))]
    const { version } = (await w.invoicing.getInvoice(invoiceId))!
    await w.webhook('invoicing', [
      { id: randomUUID(), entityType: 'invoice', entityId: invoiceId, kind, version },
    ])
    await w.sync()
    const after = [...(await writes('invoicing', invoiceId)), ...(await writes('qbo', qboId))]
    expect(after).toEqual(before)
  }

  describe('C1 invoice created in invoicing appears in QBO', () => {
    it('creates the invoice in QBO with the same number, customer, dates and lines', async () => {
      const w = world()
      // Given
      const { customer, qboId: customerQboId } = await linkedCustomer(w, 'Acme')
      const { item, qboId: itemQboId } = await linkedItem(w, 'Pickup', 'Hauling')
      // When
      const { invoice, qboId } = await linkedInvoice(w, {
        customer,
        memo: 'Thank you',
        lines: [
          {
            itemId: item.id,
            description: 'Weekly pickup',
            quantity: '2',
            unitPrice: '50.00',
            amount: '100.00',
          },
        ],
      })
      // Then
      expect(await w.qboActor.get('Invoice', qboId)).toMatchObject({
        DocNumber: invoice.number,
        CustomerRef: { value: customerQboId },
        TxnDate: ISSUE_DATE,
        DueDate: DUE_DATE,
        CustomerMemo: { value: 'Thank you' },
        TotalAmt: 100,
        Line: [
          {
            Amount: 100,
            Description: 'Weekly pickup',
            SalesItemLineDetail: { ItemRef: { value: itemQboId }, Qty: 2, UnitPrice: 50 },
          },
          { DetailType: 'SubTotalLineDetail' },
        ],
      })
      expect(await w.invoicing.listInvoices()).toHaveLength(1)
      const created = (await history('qbo', 'invoice', qboId)).find((e) => e.action === 'created')
      expect(created).toMatchObject({
        error: null,
        changes: {
          number: { from: null, to: invoice.number, source: 'invoicing' },
          customer: { from: null, source: 'invoicing' },
        },
      })
      expect(await w.issues()).toEqual([])
    })
  })

  describe('C2 invoice created in QBO appears in invoicing', () => {
    it('creates the invoice in invoicing numbered by its DocNumber', async () => {
      const w = world()
      // Given
      const { customer, qboId: customerQboId } = await linkedCustomer(w, 'Acme')
      const { item, qboId: itemQboId } = await linkedItem(w, 'Pickup', 'Hauling')
      // When
      const qboInvoice = await w.qboActor.createInvoice(customerQboId, [
        { amount: '40.00', itemId: itemQboId },
      ])
      await w.syncUntil(linkedTo('invoice', 'qbo', qboInvoice.Id), 'QBO invoice linked')
      // Then
      const link = (await w.linkOf('invoice', 'qbo', qboInvoice.Id))!
      const invoice = (await w.invoicing.getInvoice(link.invoicingId!))!
      expect(invoice).toMatchObject({
        number: qboInvoice.DocNumber,
        customerId: customer.id,
        issueDate: qboInvoice.TxnDate,
        dueDate: qboInvoice.DueDate,
        tax: '0.00',
        total: '40.00',
        lines: [{ itemId: item.id, quantity: '1', unitPrice: '40.00', amount: '40.00' }],
      })
      expect(await w.invoicing.listInvoices()).toHaveLength(1)
      const created = (await history('invoicing', 'invoice', invoice.id)).find(
        (e) => e.action === 'created'
      )
      expect(created).toMatchObject({
        error: null,
        changes: { number: { from: null, to: qboInvoice.DocNumber, source: 'qbo' } },
      })
      expect(await w.issues()).toEqual([])
    })
  })

  describe('C6 QBO invoice with sales tax is imported with its tax', () => {
    // a QBO invoice of one taxed 15.00 line at the 8 % rate, synced
    async function taxedQboInvoice() {
      const w = world()
      const customer = await linkedCustomer(w, 'Acme')
      const item = await linkedItem(w, 'Pickup', 'Hauling')
      const qboInvoice = await w.qboActor.createInvoice(
        customer.qboId,
        [{ amount: '15.00', itemId: item.qboId, taxCode: LINE_TAXED }],
        { TxnTaxDetail: { TxnTaxCodeRef: { value: TXN_TAX_RATE } } }
      )
      await w.syncUntil(linkedTo('invoice', 'qbo', qboInvoice.Id), 'QBO invoice linked')
      return { customer, item, qboInvoice }
    }

    it('imports the lines, the tax and the total', async () => {
      const w = world()
      // Given, When
      const { customer, item, qboInvoice } = await taxedQboInvoice()
      // Then
      const link = (await w.linkOf('invoice', 'qbo', qboInvoice.Id))!
      expect(await w.invoicing.getInvoice(link.invoicingId!)).toMatchObject({
        customerId: customer.customer.id,
        lines: [{ itemId: item.item.id, amount: '15.00' }],
        tax: '1.20',
        total: '16.20',
      })
      expect(await w.issues()).toEqual([])
    })

    it('is paid in full on both sides by a QBO payment of 16.20', async () => {
      const w = world()
      // Given
      const { customer, qboInvoice } = await taxedQboInvoice()
      // When
      const qboPayment = await w.qboActor.createPayment(customer.qboId, '16.20', [
        { invoiceId: qboInvoice.Id, amount: '16.20' },
      ])
      await w.syncUntil(linkedTo('payment', 'qbo', qboPayment.Id), 'QBO payment linked')
      // Then
      const invoiceId = (await w.linkOf('invoice', 'qbo', qboInvoice.Id))!.invoicingId!
      const paymentId = (await w.linkOf('payment', 'qbo', qboPayment.Id))!.invoicingId!
      expect(await w.invoicing.getPayment(paymentId)).toMatchObject({
        amount: '16.20',
        allocations: [{ invoiceId, amount: '16.20' }],
      })
      expect(await w.invoicing.getInvoice(invoiceId)).toMatchObject({ status: 'paid' })
      expect(await w.qboActor.get('Invoice', qboInvoice.Id)).toMatchObject({ Balance: 0 })
      expect(await w.issues()).toEqual([])
    })
  })

  describe('U1 edit in invoicing reaches QBO', () => {
    it('copies the memo, due date and added, changed and removed lines', async () => {
      const w = world()
      // Given
      const given = await twoLineInvoice(w)
      const { pickup } = given
      const extra = await w.invoicing.createItem(
        { name: w.named('Bin rental'), incomeAccountId: pickup.item.incomeAccountId },
        randomUUID()
      )
      await w.sync()
      const extraQboId = (await w.linkOf('item', 'invoicing', extra.id))!.qboId!
      // When the pickup line changes, the disposal line goes and a bin rental line comes
      const [pickupLine] = (await w.invoicing.getInvoice(given.invoice.id))!.lines
      await editInvoice(w, given.invoice.id, {
        memo: 'Gate code 1234',
        dueDate: NEW_DUE_DATE,
        lines: [
          { ...pickupLine!, quantity: '3', amount: '150.00' },
          { itemId: extra.id, quantity: '1', unitPrice: '20.00', amount: '20.00' },
        ],
      })
      await w.sync()
      // Then
      const qbo = (await w.qboActor.get('Invoice', given.qboId))!
      expect(qbo).toMatchObject({
        CustomerMemo: { value: 'Gate code 1234' },
        DueDate: NEW_DUE_DATE,
        TotalAmt: 170,
      })
      expect(qbo.Line.filter((l) => l.DetailType === 'SalesItemLineDetail')).toMatchObject([
        { Amount: 150, SalesItemLineDetail: { ItemRef: { value: pickup.qboId }, Qty: 3 } },
        { Amount: 20, SalesItemLineDetail: { ItemRef: { value: extraQboId }, Qty: 1 } },
      ])
      const [updated, ...more] = await updates('qbo', given.qboId)
      expect(more).toEqual([])
      expect(updated).toMatchObject({
        error: null,
        changes: {
          memo: { from: null, to: 'Gate code 1234', source: 'invoicing' },
          dueDate: { to: NEW_DUE_DATE, source: 'invoicing' },
          lines: { source: 'invoicing' },
        },
      })
      expect(Object.keys(updated!.changes!).sort()).toEqual(['dueDate', 'lines', 'memo'])
      expect(await updates('invoicing', given.invoice.id)).toEqual([])
      expect(await w.issues()).toEqual([])
    })

    it('clears the QBO memo when the invoicing memo is cleared', async () => {
      const w = world()
      // Given
      const given = await twoLineInvoice(w)
      await editInvoice(w, given.invoice.id, { memo: 'Gate code 1234' })
      await w.sync()
      // When
      await editInvoice(w, given.invoice.id, { memo: null })
      await w.sync()
      // Then
      const qbo = (await w.qboActor.get('Invoice', given.qboId))!
      expect(qbo.CustomerMemo?.value ?? '').toBe('')
      expect(await updates('qbo', given.qboId)).toContainEqual(
        expect.objectContaining({
          error: null,
          changes: { memo: { from: 'Gate code 1234', to: null, source: 'invoicing' } },
        })
      )
      expect(await w.issues()).toEqual([])
    })
  })

  describe('U2 edit in QBO reaches invoicing', () => {
    it('copies the memo, due date and added, changed and removed lines', async () => {
      const w = world()
      // Given
      const given = await twoLineInvoice(w)
      const { pickup, disposal } = given
      const invoice = async () => (await w.invoicing.getInvoice(given.invoice.id))!
      const [pickupLine] = (await invoice()).lines
      // When the pickup line changes, the disposal line goes and a second pickup line comes
      await w.qboActor.updateInvoice(given.qboId, {
        CustomerMemo: { value: 'Call ahead' },
        DueDate: NEW_DUE_DATE,
        Line: [qboLine(disposal.qboId, 2, 30, 60), qboLine(pickup.qboId, 1, 45, 45)],
      })
      await w.syncUntil(async () => (await invoice()).memo === 'Call ahead', 'QBO edit synced')
      // Then
      const after = await invoice()
      expect(after).toMatchObject({
        memo: 'Call ahead',
        dueDate: NEW_DUE_DATE,
        total: '105.00',
        lines: [
          { id: pickupLine!.id, itemId: disposal.item.id, quantity: '2', amount: '60.00' },
          { itemId: pickup.item.id, quantity: '1', unitPrice: '45.00', amount: '45.00' },
        ],
      })
      expect(after.lines).toHaveLength(2)
      const [updated, ...more] = await updates('invoicing', given.invoice.id)
      expect(more).toEqual([])
      expect(updated).toMatchObject({
        error: null,
        changes: {
          memo: { from: null, to: 'Call ahead', source: 'qbo' },
          dueDate: { to: NEW_DUE_DATE, source: 'qbo' },
          lines: { source: 'qbo' },
        },
      })
      expect(await updates('qbo', given.qboId)).toEqual([])
      expect(await w.issues()).toEqual([])
    })
  })

  describe('V1 void in invoicing voids in QBO', () => {
    it('voids the QBO invoice and audits it as voided', async () => {
      const w = world()
      // Given
      const given = await invoiceOf100()
      // When
      await w.invoicing.voidInvoice(given.invoice.id, given.invoice.version)
      await w.sync()
      // Then
      const qbo = (await w.qboActor.get('Invoice', given.qboId))!
      expect(qbo.PrivateNote).toMatch(/^Voided/)
      expect(qbo.TotalAmt).toBe(0)
      expect(await writes('qbo', given.qboId)).toMatchObject([
        { action: 'voided', error: null, changes: { voided: { to: true, source: 'invoicing' } } },
      ])
      expect(await w.issues()).toEqual([])
      await redeliveryWritesNothing(given.invoice.id, given.qboId, 'voided')
    })
  })

  describe('V2 void in QBO voids in invoicing', () => {
    it('voids the invoicing invoice, which keeps its lines', async () => {
      const w = world()
      // Given
      const given = await invoiceOf100()
      // When
      await w.qboActor.voidInvoice(given.qboId)
      await w.syncUntil(
        async () => (await w.invoicing.getInvoice(given.invoice.id))!.status === 'void',
        'QBO void synced'
      )
      // Then
      expect(await w.invoicing.getInvoice(given.invoice.id)).toMatchObject({
        status: 'void',
        total: '100.00',
      })
      expect(await writes('invoicing', given.invoice.id)).toMatchObject([
        { action: 'voided', error: null, changes: { voided: { to: true, source: 'qbo' } } },
      ])
      expect(await w.issues()).toEqual([])
      await redeliveryWritesNothing(given.invoice.id, given.qboId, 'voided')
    })
  })

  describe('V5 delete in QBO deletes in invoicing', () => {
    it('removes the allocation from the payment first, then deletes the invoice', async () => {
      const w = world()
      // Given
      const given = await invoiceOf100()
      const { payment } = await linkedPayment(w, given.invoice, '40.00')
      // When
      await w.qboActor.deleteInvoice(given.qboId)
      await w.syncUntil(
        async () => (await w.invoicing.getInvoice(given.invoice.id))!.deletedAt !== null,
        'QBO delete synced'
      )
      // Then
      expect(await w.invoicing.getPayment(payment.id)).toMatchObject({
        amount: '40.00',
        unapplied: '40.00',
        allocations: [],
        deletedAt: null,
      })
      const freed = (await history('invoicing', 'payment', payment.id)).find(
        (e) => e.action === 'updated'
      )
      const deleted = (await writes('invoicing', given.invoice.id)).find(
        (e) => e.action === 'deleted'
      )
      expect(freed).toMatchObject({ error: null, changes: { allocations: { to: [] } } })
      expect(deleted).toMatchObject({ error: null })
      expect(Number(freed!.id)).toBeLessThan(Number(deleted!.id))
      expect((await w.linkOf('invoice', 'qbo', given.qboId))!.deletedAt).not.toBeNull()
      expect(await w.issues()).toEqual([])
    })
  })

  describe('P1 payment recorded in invoicing appears in QBO', () => {
    it('creates and links a QBO payment applied to the invoice', async () => {
      const w = world()
      // Given
      const given = await invoiceOf100()
      // When
      const { payment, qboId } = await linkedPayment(w, given.invoice, '100.00')
      // Then
      expect(await w.qboActor.get('Payment', qboId)).toMatchObject({
        CustomerRef: { value: given.customer.qboId },
        TotalAmt: 100,
        Line: [{ Amount: 100, LinkedTxn: [{ TxnId: given.qboId, TxnType: 'Invoice' }] }],
      })
      expect(await w.qboActor.get('Invoice', given.qboId)).toMatchObject({ Balance: 0 })
      expect(await w.linkOf('payment', 'qbo', qboId)).toMatchObject({ invoicingId: payment.id })
      expect(await w.invoicing.getInvoice(given.invoice.id)).toMatchObject({ status: 'paid' })
      await w.sync()
      expect(await updates('invoicing', given.invoice.id)).toEqual([])
      expect(await updates('qbo', given.qboId)).toEqual([])
      expect(await w.issues()).toEqual([])
    })
  })

  describe('P2 payment recorded in QBO appears in invoicing', () => {
    it('creates an invoicing payment allocated to the invoice', async () => {
      const w = world()
      // Given
      const given = await invoiceOf100()
      // When
      const qboPayment = await w.qboActor.createPayment(given.customer.qboId, '40.00', [
        { invoiceId: given.qboId, amount: '40.00' },
      ])
      await w.syncUntil(linkedTo('payment', 'qbo', qboPayment.Id), 'QBO payment linked')
      // Then
      const link = (await w.linkOf('payment', 'qbo', qboPayment.Id))!
      expect(await w.invoicing.getPayment(link.invoicingId!)).toMatchObject({
        customerId: given.customer.customer.id,
        amount: '40.00',
        allocations: [{ invoiceId: given.invoice.id, amount: '40.00' }],
      })
      expect(await w.invoicing.getInvoice(given.invoice.id)).toMatchObject({
        status: 'partly_paid',
        paid: '40.00',
        balance: '60.00',
      })
      await w.sync()
      expect(await updates('invoicing', given.invoice.id)).toEqual([])
      expect(await updates('qbo', given.qboId)).toEqual([])
      expect(await w.issues()).toEqual([])
    })
  })

  describe('E1 duplicate webhook', () => {
    // notifications of edits to the invoice
    const editsReceived = async (invoiceId: string) =>
      (await history('invoicing', 'invoice', invoiceId)).filter(
        (e) =>
          e.action === 'notification_received' &&
          (e.details as { kind?: string }).kind === 'updated'
      )

    it('writes the change once when the duplicate arrives with the original', async () => {
      const w = world()
      // Given
      const given = await twoLineInvoice(w)
      const syncToken = async () =>
        Number((await w.qboActor.get('Invoice', given.qboId))!.SyncToken)
      const before = await syncToken()
      await editInvoice(w, given.invoice.id, { memo: 'Gate code 1234' })
      // When
      await w.deliver({ duplicate: true })
      await w.sync()
      // Then
      expect(await syncToken()).toBe(before + 1)
      expect(await updates('qbo', given.qboId)).toHaveLength(1)
      expect(await editsReceived(given.invoice.id)).toHaveLength(2)
    })

    it('finds nothing to do when the same event is delivered again after the sync', async () => {
      const w = world()
      // Given a change already synced
      const given = await twoLineInvoice(w)
      await editInvoice(w, given.invoice.id, { memo: 'Gate code 1234' })
      const [event] = w.invoicing.takeWebhooks()
      await w.webhook('invoicing', [event!])
      await w.sync()
      const syncToken = (await w.qboActor.get('Invoice', given.qboId))!.SyncToken
      const jobs = () =>
        w.db
          .selectFrom('sync_jobs')
          .select(['id', 'status'])
          .where('system', '=', 'invoicing')
          .where('entity_type', '=', 'invoice')
          .where('entity_id', '=', given.invoice.id)
          .execute()
      const earlier = (await jobs()).map((j) => j.id)
      // When
      await w.webhook('invoicing', [event!])
      await w.sync()
      // Then
      const [redelivered, ...more] = (await jobs()).filter((j) => !earlier.includes(j.id))
      expect(more).toEqual([])
      expect(redelivered).toMatchObject({ status: 'done' })
      expect((await history('invoicing', 'invoice', given.invoice.id)).at(-1)).toMatchObject({
        action: 'no_change',
        error: null,
      })
      expect((await w.qboActor.get('Invoice', given.qboId))!.SyncToken).toBe(syncToken)
      expect(await updates('qbo', given.qboId)).toHaveLength(1)
    })
  })

  describe('F2 both systems edit the same field differently', () => {
    it('writes neither side and flags a conflict holding both versions', async () => {
      const w = world()
      // Given
      const given = await twoLineInvoice(w)
      // When invoicing drops the disposal line and QBO doubles it
      const [pickupLine] = (await w.invoicing.getInvoice(given.invoice.id))!.lines
      const edited = await editInvoice(w, given.invoice.id, { lines: [pickupLine!] })
      const qbo = await w.qboActor.updateInvoice(given.qboId, {
        Line: [qboLine(given.pickup.qboId, 2, 50, 100), qboLine(given.disposal.qboId, 2, 30, 60)],
      })
      await w.syncUntil(async () => (await w.issues()).length > 0, 'conflict flagged')
      // Then
      expect((await w.invoicing.getInvoice(given.invoice.id))!.version).toBe(edited.version)
      expect((await w.qboActor.get('Invoice', given.qboId))!.SyncToken).toBe(qbo.SyncToken)
      const [issue, ...more] = await w.issues()
      expect(more).toEqual([])
      expect(issue).toMatchObject({
        kind: 'conflict',
        resolution: null,
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
      expect(issue!.details.conflicts).toHaveLength(1)
      expect([
        ...(await actions('invoicing', given.invoice.id)),
        ...(await actions('qbo', given.qboId)),
      ]).toContain('issue_opened')
      expect(await actions('invoicing', given.invoice.id)).not.toContain('updated')
      expect(await actions('qbo', given.qboId)).not.toContain('updated')
    })
  })

  describe('R1 timeout after a write to QBO', () => {
    it('ends with one QBO invoice, linked, whether the create is replayed or adopted', async () => {
      const w = world()
      // Given
      const { customer } = await linkedCustomer(w, 'Acme')
      const { item } = await linkedItem(w, 'Pickup', 'Hauling')
      w.hook(
        'qbo',
        { method: 'POST', path: '/invoice' },
        () => {
          throw timeoutError()
        },
        'after'
      )
      // When QBO creates the invoice and the response is lost
      const invoice = await w.invoicing.createInvoice(
        {
          customerId: customer.id,
          issueDate: ISSUE_DATE,
          dueDate: DUE_DATE,
          lines: [{ itemId: item.id, quantity: '1', unitPrice: '80.00', amount: '80.00' }],
        },
        randomUUID()
      )
      await w.sync()
      await w.clock.advance(PAST_BACKOFF_MS)
      await w.syncUntil(
        async () => (await w.linkOf('invoice', 'invoicing', invoice.id))?.qboId != null,
        'invoice linked'
      )
      // Then
      const [qboInvoice, ...more] = await w.ctx.qbo.findInvoicesByNumber(invoice.number)
      expect(more).toEqual([])
      expect(await w.linkOf('invoice', 'invoicing', invoice.id)).toMatchObject({
        qboId: qboInvoice!.Id,
      })
      expect(await w.issues()).toEqual([])
    })
  })

  describe('L1 same invoice exists on both sides', () => {
    it('links the two invoices and creates nothing', async () => {
      const w = world()
      // Given the same invoice entered on both sides by hand
      const { customer, qboId: customerQboId } = await linkedCustomer(w, 'Acme')
      const { item, qboId: itemQboId } = await linkedItem(w, 'Pickup', 'Hauling')
      const invoice = await w.invoicing.createInvoice(
        {
          customerId: customer.id,
          issueDate: ISSUE_DATE,
          dueDate: DUE_DATE,
          lines: [{ itemId: item.id, quantity: '1', unitPrice: '100.00', amount: '100.00' }],
        },
        randomUUID()
      )
      const qboInvoice = await w.qboActor.createInvoice(
        customerQboId,
        [{ amount: '100.00', itemId: itemQboId }],
        { DocNumber: invoice.number, TxnDate: ISSUE_DATE, DueDate: DUE_DATE }
      )
      // When
      await w.syncUntil(linkedTo('invoice', 'qbo', qboInvoice.Id), 'invoices linked')
      // Then
      expect(await w.linkOf('invoice', 'invoicing', invoice.id)).toMatchObject({
        qboId: qboInvoice.Id,
      })
      expect(await w.invoicing.listInvoices({ number: invoice.number })).toHaveLength(1)
      expect(await w.ctx.qbo.findInvoicesByNumber(invoice.number)).toHaveLength(1)
      const histories = [
        ...(await history('invoicing', 'invoice', invoice.id)),
        ...(await history('qbo', 'invoice', qboInvoice.Id)),
      ]
      expect(histories.filter((e) => e.action === 'linked')).toHaveLength(1)
      expect(histories.filter((e) => e.action === 'created')).toEqual([])
      expect(await w.issues()).toEqual([])
    })
  })
}
