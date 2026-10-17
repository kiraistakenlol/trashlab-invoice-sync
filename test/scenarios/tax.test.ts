// Sales tax as a QBO-owned field (SCENARIOS.md C6, U7).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createWorld, type World } from '../harness/world.js'
import {
  DUE_DATE,
  editInvoice,
  ISSUE_DATE,
  linkedCustomer,
  linkedItem,
  twoLineInvoice,
} from './given.js'

let w: World
beforeEach(async () => {
  w = await createWorld()
})
afterEach(() => w.close())

describe('C6 QBO invoice with sales tax is imported with its tax', () => {
  // the payment of 16.20 paying it in full on both sides is covered with payments
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
          TaxCodeRef: { value: 'TAX' },
        },
      })
      // When the lines are edited in QBO with a tax code
      const updated = await w.qboActor.updateInvoice(given.qboId, {
        Line: [taxedLine(100, given.pickup.qboId)],
        TxnTaxDetail: { TxnTaxCodeRef: { value: '2' } },
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
