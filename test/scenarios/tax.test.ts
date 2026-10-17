// Sales tax as a QBO-owned field (SCENARIOS.md C6, U7).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createWorld, type World } from '../harness/world.js'
import {
  DUE_DATE,
  editInvoice,
  invoicingEvents,
  ISSUE_DATE,
  linkedCustomer,
  linkedItem,
  twoLineInvoice,
} from './given.js'

const PAST_BACKOFF_MS = 1_000
// QBO tax code ids in the fake: line codes and the transaction-level rate code
const LINE_TAXED = 'TAX'
const TXN_TAX_RATE = '2'

let w: World
beforeEach(async () => {
  w = await createWorld()
})
afterEach(() => w.close())

describe('C6 QBO invoice with sales tax is imported with its tax', () => {
  it('imports the lines, the tax and the total', async () => {
    // Given
    const { customer, qboId: customerQboId } = await linkedCustomer(w, 'Acme')
    const { item, qboId: itemQboId } = await linkedItem(w, 'Pickup', 'Hauling')
    const qboInvoice = await w.qboActor.createInvoice(customerQboId, [
      { amount: '15.00', itemId: itemQboId },
    ])
    // When the QBO UI saves it, adding sales tax
    w.qbo.uiSaveInvoice(qboInvoice.Id)
    await w.sync()
    // Then
    const link = (await w.linkOf('invoice', 'qbo', qboInvoice.Id))!
    expect(await w.invoicing.getInvoice(link.invoicingId!)).toMatchObject({
      customerId: customer.id,
      lines: [{ itemId: item.id, amount: '15.00' }],
      tax: '1.20',
      total: '16.20',
    })
    expect(await w.issues()).toEqual([])
  })

  it('is paid in full on both sides by a QBO payment of 16.20', async () => {
    // Given
    const { qboId: customerQboId } = await linkedCustomer(w, 'Acme')
    const { qboId: itemQboId } = await linkedItem(w, 'Pickup', 'Hauling')
    const qboInvoice = await w.qboActor.createInvoice(customerQboId, [
      { amount: '15.00', itemId: itemQboId },
    ])
    w.qbo.uiSaveInvoice(qboInvoice.Id)
    await w.sync()
    // When
    const qboPayment = await w.qboActor.createPayment(customerQboId, '16.20', [
      { invoiceId: qboInvoice.Id, amount: '16.20' },
    ])
    await w.sync()
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

describe('invoicing-created invoice with tax', () => {
  it('is flagged unsupported and not created in QBO', async () => {
    // Given
    const { customer } = await linkedCustomer(w, 'Acme')
    const { item } = await linkedItem(w, 'Pickup', 'Hauling')
    // When
    const invoice = await w.invoicing.createInvoice(
      {
        customerId: customer.id,
        issueDate: ISSUE_DATE,
        dueDate: DUE_DATE,
        tax: '1.20',
        lines: [{ itemId: item.id, quantity: '1', unitPrice: '15.00', amount: '15.00' }],
      },
      'taxed-invoice'
    )
    await w.sync()
    // Then
    expect(await w.issues()).toMatchObject([
      { kind: 'unsupported', details: { reason: 'tax is set in QBO only' } },
    ])
    expect(await w.linkOf('invoice', 'invoicing', invoice.id)).toBeNull()
    const res = await w.qbo.query('select * from Invoice')
    expect(
      (res.body as { QueryResponse: { Invoice?: unknown[] } }).QueryResponse.Invoice ?? []
    ).toEqual([])
  })
})

describe('taxed invoice created in both places or half-created', () => {
  const taxedInvoicingInput = (customerId: string, itemId: string, number?: string) => ({
    ...(number ? { number } : {}),
    customerId,
    issueDate: ISSUE_DATE,
    dueDate: DUE_DATE,
    tax: '1.20',
    lines: [{ itemId, quantity: '1', unitPrice: '15.00', amount: '15.00' }],
  })

  it('adopts the invoicing invoice of a taxed QBO import whose create timed out', async () => {
    // Given
    const { qboId: customerQboId } = await linkedCustomer(w, 'Acme')
    const { qboId: itemQboId } = await linkedItem(w, 'Pickup', 'Hauling')
    const qboInvoice = await w.qboActor.createInvoice(customerQboId, [
      { amount: '15.00', itemId: itemQboId },
    ])
    w.qbo.uiSaveInvoice(qboInvoice.Id)
    w.invoicing.failNext('createInvoice', 'timeout_after_write')
    // When the response is lost, and the new invoice's event is processed before the retry
    await w.deliver()
    await w.drain()
    await w.deliver()
    await w.drain()
    w.clock.advance(PAST_BACKOFF_MS)
    await w.sync()
    // Then
    const [invoice, ...more] = await w.invoicing.listInvoices({ number: qboInvoice.DocNumber })
    expect(more).toEqual([])
    expect(invoice).toMatchObject({ tax: '1.20', total: '16.20' })
    expect(await w.linkOf('invoice', 'qbo', qboInvoice.Id)).toMatchObject({
      invoicingId: invoice!.id,
    })
    expect(await w.issues()).toEqual([])
  })

  it('links a taxed invoice that exists on both sides without creating anything', async () => {
    // Given
    const { customer, qboId: customerQboId } = await linkedCustomer(w, 'Acme')
    const { item, qboId: itemQboId } = await linkedItem(w, 'Pickup', 'Hauling')
    const qboInvoice = await w.qboActor.createInvoice(
      customerQboId,
      [{ amount: '15.00', itemId: itemQboId }],
      { DocNumber: 'A-100' }
    )
    w.qbo.uiSaveInvoice(qboInvoice.Id)
    // When only the invoicing invoice's event is processed
    const invoice = await w.invoicing.createInvoice(
      taxedInvoicingInput(customer.id, item.id, 'A-100'),
      'k-invoice'
    )
    await w.deliver({ drop: (e) => !invoicingEvents('invoice')(e) })
    await w.drain()
    // Then
    expect(await w.linkOf('invoice', 'invoicing', invoice.id)).toMatchObject({
      qboId: qboInvoice.Id,
    })
    expect(await w.invoicing.listInvoices()).toHaveLength(1)
    expect(await w.issues()).toEqual([])
  })
})

describe('taxed invoice', () => {
  const taxed = async () => {
    const given = await twoLineInvoice(w)
    w.qbo.uiSaveInvoice(given.qboId)
    await w.sync()
    return given
  }

  describe('U7 lines of a taxed invoice edited in invoicing are flagged', () => {
    it('writes nothing to QBO and flags the invoice', async () => {
      // Given tax 10.40 on 130.00
      const given = await taxed()
      const before = await w.qboActor.get('Invoice', given.qboId)
      expect(await w.invoicing.getInvoice(given.invoice.id)).toMatchObject({ tax: '10.40' })
      // When
      const [pickupLine] = (await w.invoicing.getInvoice(given.invoice.id))!.lines
      await editInvoice(w, given.invoice.id, {
        lines: [{ ...pickupLine!, quantity: '3', amount: '150.00' }],
      })
      await w.sync()
      // Then
      expect((await w.qboActor.get('Invoice', given.qboId))!.SyncToken).toBe(before!.SyncToken)
      const [issue] = await w.issues()
      expect(issue).toMatchObject({
        kind: 'taxed_lines_edited',
        details: { reason: 'tax is set in QBO; edit these lines in QBO' },
      })
      expect(await w.history('invoicing', 'invoice', given.invoice.id)).toContainEqual(
        expect.objectContaining({
          action: 'issue_opened',
          details: { issueId: issue!.id, kind: 'taxed_lines_edited' },
        })
      )
    })

    it('flags a tax edit made directly in invoicing', async () => {
      // Given
      const given = await taxed()
      const before = await w.qboActor.get('Invoice', given.qboId)
      // When
      await editInvoice(w, given.invoice.id, { tax: '5.00' })
      await w.sync()
      // Then
      expect((await w.qboActor.get('Invoice', given.qboId))!.SyncToken).toBe(before!.SyncToken)
      expect(await w.issues()).toMatchObject([{ kind: 'taxed_lines_edited' }])
    })

    it('still syncs a memo edit without an issue', async () => {
      // Given
      const given = await taxed()
      // When
      await editInvoice(w, given.invoice.id, { memo: 'Gate code 1234' })
      await w.sync()
      // Then
      expect(await w.qboActor.get('Invoice', given.qboId)).toMatchObject({
        CustomerMemo: { value: 'Gate code 1234' },
        TxnTaxDetail: { TotalTax: 10.4 },
      })
      expect(await w.issues()).toEqual([])
    })
  })

  describe('QBO tax change', () => {
    it('reaches invoicing with the lines', async () => {
      // Given
      const given = await taxed()
      const taxedLine = (amount: number, itemId: string) => ({
        Amount: amount,
        DetailType: 'SalesItemLineDetail',
        SalesItemLineDetail: {
          ItemRef: { value: itemId },
          Qty: 1,
          UnitPrice: amount,
          TaxCodeRef: { value: LINE_TAXED },
        },
      })
      // When the lines are edited in QBO with a tax code
      const updated = await w.qboActor.updateInvoice(given.qboId, {
        Line: [taxedLine(100, given.pickup.qboId)],
        TxnTaxDetail: { TxnTaxCodeRef: { value: TXN_TAX_RATE } },
      })
      await w.sync()
      // Then
      const invoice = (await w.invoicing.getInvoice(given.invoice.id))!
      expect(updated.TxnTaxDetail?.TotalTax).toBeGreaterThan(0)
      expect(invoice.lines).toMatchObject([{ amount: '100.00' }])
      expect(Number(invoice.tax)).toBe(updated.TxnTaxDetail!.TotalTax)
      expect(Number(invoice.total)).toBe(updated.TotalAmt)
      expect(await w.issues()).toEqual([])
    })
  })
})
