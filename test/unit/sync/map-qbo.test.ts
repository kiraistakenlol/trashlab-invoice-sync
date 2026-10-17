import { describe, expect, it } from 'vitest'
import { neutralToQbo, qboToNeutral } from '../../../src/sync/map-qbo.js'
import type { QboInvoice, QboPayment } from '../../../src/qbo/entities.js'

const toLink = (type: string, id: string) => `${type}-link-${id}`
const toSide = (linkId: string) => linkId.split('-link-')[1]!

const meta = { CreateTime: '2026-01-01T00:00:00Z', LastUpdatedTime: '2026-01-01T00:00:00Z' }

const invoice: QboInvoice = {
  Id: '10',
  SyncToken: '0',
  DocNumber: 'INV-1',
  CustomerRef: { value: '1', name: 'Acme' },
  TxnDate: '2026-01-01',
  DueDate: '2026-01-31',
  CustomerMemo: { value: 'thanks' },
  CurrencyRef: { value: 'USD' },
  Line: [
    {
      Id: '1',
      Amount: 25,
      Description: 'Pickup',
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: { ItemRef: { value: '5' }, Qty: 2.5, UnitPrice: 10 },
    },
    { Amount: 25, DetailType: 'SubTotalLineDetail' },
  ],
  TxnTaxDetail: { TotalTax: 1.5, TxnTaxCodeRef: { value: 'TAX' } },
  TotalAmt: 26.5,
  Balance: 26.5,
  LinkedTxn: [],
  MetaData: meta,
}

const asNeutral = (i: QboInvoice) => {
  const n = qboToNeutral.invoice(i, toLink)
  if ('unsupported' in n) throw new Error(n.unsupported)
  return n
}

describe('QBO mapper', () => {
  it('maps an invoice, skipping the subtotal line', () => {
    expect(asNeutral(invoice)).toEqual({
      number: 'INV-1',
      customer: 'customer-link-1',
      issueDate: '2026-01-01',
      dueDate: '2026-01-31',
      memo: 'thanks',
      lines: [
        {
          item: 'item-link-5',
          description: 'Pickup',
          quantity: '2.5',
          unitPrice: '10.00',
          amount: '25.00',
        },
      ],
      tax: '1.50',
      voided: false,
    })
  })

  it('round-trips an invoice through the create body', () => {
    const n = asNeutral(invoice)
    const body = neutralToQbo.invoiceCreate(n, toSide)
    expect(body).toEqual({
      DocNumber: 'INV-1',
      CustomerRef: { value: '1' },
      TxnDate: '2026-01-01',
      DueDate: '2026-01-31',
      CustomerMemo: { value: 'thanks' },
      Line: [
        {
          Amount: 25,
          Description: 'Pickup',
          DetailType: 'SalesItemLineDetail',
          SalesItemLineDetail: { ItemRef: { value: '5' }, Qty: 2.5, UnitPrice: 10 },
        },
      ],
    })
    const echoed = { ...invoice, ...body, Line: body.Line }
    expect(asNeutral(echoed as QboInvoice)).toEqual({ ...n, tax: '1.50' })
  })

  it('defaults a missing due date to the invoice date, and absent memo to null', () => {
    const n = asNeutral({ ...invoice, DueDate: undefined, CustomerMemo: undefined })
    expect(n.dueDate).toBe('2026-01-01')
    expect(n.memo).toBeNull()
    expect(asNeutral({ ...invoice, CustomerMemo: { value: '' } }).memo).toBeNull()
  })

  it('reports zero tax when there is no tax detail', () => {
    expect(asNeutral({ ...invoice, TxnTaxDetail: undefined }).tax).toBe('0.00')
  })

  it('detects a voided invoice', () => {
    const voided: QboInvoice = {
      ...invoice,
      PrivateNote: 'Voided - ',
      Line: [{ ...(invoice.Line[0] as object), Amount: 0 } as QboInvoice['Line'][number]],
    }
    expect(asNeutral(voided).voided).toBe(true)
    expect(asNeutral({ ...invoice, PrivateNote: 'Voided - ' }).voided).toBe(false)
  })

  it.each([
    ['DescriptionOnly', { Amount: 0, DetailType: 'DescriptionOnly' as const }],
    ['DiscountLineDetail', { Amount: 1, DetailType: 'DiscountLineDetail' as const }],
  ])('flags a %s line as unsupported', (_name, line) => {
    const n = qboToNeutral.invoice({ ...invoice, Line: [...invoice.Line, line] }, toLink)
    expect(n).toHaveProperty('unsupported')
  })

  it('flags a foreign currency and a missing number as unsupported', () => {
    expect(
      qboToNeutral.invoice({ ...invoice, CurrencyRef: { value: 'EUR' } }, toLink)
    ).toHaveProperty('unsupported')
    expect(qboToNeutral.invoice({ ...invoice, DocNumber: undefined }, toLink)).toHaveProperty(
      'unsupported'
    )
  })

  it('strips "(deleted)" from inactive customers and accounts only', () => {
    const c = {
      Id: '1',
      SyncToken: '1',
      DisplayName: 'Acme (deleted)',
      Active: false,
      MetaData: meta,
    }
    expect(qboToNeutral.customer(c)).toEqual({ name: 'Acme', active: false })
    expect(qboToNeutral.customer({ ...c, Active: true }).name).toBe('Acme (deleted)')
    const a = {
      Id: '2',
      SyncToken: '1',
      Name: 'Sales (deleted)',
      AccountType: 'Income',
      Active: false,
      MetaData: meta,
    }
    expect(qboToNeutral.account(a)).toEqual({ name: 'Sales', active: false })
  })

  it('maps items and flags inventory items', () => {
    const item = {
      Id: '5',
      SyncToken: '0',
      Name: 'Pickup',
      Type: 'Service' as const,
      IncomeAccountRef: { value: '7' },
      Active: true,
      MetaData: meta,
    }
    const n = qboToNeutral.item(item, toLink)
    expect(n).toEqual({ name: 'Pickup', incomeAccount: 'account-link-7', active: true })
    expect(qboToNeutral.item({ ...item, Type: 'NonInventory' }, toLink)).toEqual(n)
    expect(qboToNeutral.item({ ...item, Type: 'Inventory' }, toLink)).toHaveProperty('unsupported')
    if ('unsupported' in n) throw new Error()
    expect(neutralToQbo.itemCreate(n, toSide)).toEqual({
      Name: 'Pickup',
      Type: 'Service',
      IncomeAccountRef: { value: '7' },
    })
  })

  it('builds customer and account create bodies', () => {
    expect(neutralToQbo.customerCreate({ name: 'Acme', active: true })).toEqual({
      DisplayName: 'Acme',
    })
    expect(neutralToQbo.accountCreate({ name: 'Sales', active: true })).toEqual({
      Name: 'Sales',
      AccountType: 'Income',
    })
  })

  it('maps a payment with sorted allocations and ignores non-invoice lines', () => {
    const p: QboPayment = {
      Id: '20',
      SyncToken: '0',
      CustomerRef: { value: '1' },
      TotalAmt: 30,
      TxnDate: '2026-02-01',
      UnappliedAmt: 0,
      Line: [
        { Amount: 10, LinkedTxn: [{ TxnId: '12', TxnType: 'Invoice' }] },
        { Amount: 20, LinkedTxn: [{ TxnId: '11', TxnType: 'Invoice' }] },
        { Amount: 5, LinkedTxn: [] },
      ],
      MetaData: meta,
    }
    const n = qboToNeutral.payment(p, toLink)
    expect(n).toEqual({
      customer: 'customer-link-1',
      date: '2026-02-01',
      amount: '30.00',
      allocations: [
        { invoice: 'invoice-link-11', amount: '20.00' },
        { invoice: 'invoice-link-12', amount: '10.00' },
      ],
    })
    expect(neutralToQbo.paymentCreate(n, toSide)).toEqual({
      CustomerRef: { value: '1' },
      TotalAmt: 30,
      TxnDate: '2026-02-01',
      Line: [
        { Amount: 20, LinkedTxn: [{ TxnId: '11', TxnType: 'Invoice' }] },
        { Amount: 10, LinkedTxn: [{ TxnId: '12', TxnType: 'Invoice' }] },
      ],
    })
  })

  describe('invoice patch', () => {
    it('sends only the changed fields', () => {
      expect(neutralToQbo.invoicePatch({ dueDate: '2026-03-01' }, invoice, toSide)).toEqual({
        DueDate: '2026-03-01',
      })
    })

    it('clears the memo with an empty value', () => {
      expect(neutralToQbo.invoicePatch({ memo: null }, invoice, toSide)).toEqual({
        CustomerMemo: { value: '' },
      })
    })

    it('sends all lines without ids, keeping the tax code', () => {
      const n = asNeutral(invoice)
      const patch = neutralToQbo.invoicePatch({ lines: n.lines }, invoice, toSide)
      expect(patch.Line).toHaveLength(1)
      expect(patch.Line?.[0]).not.toHaveProperty('Id')
      expect(patch.TxnTaxDetail).toEqual({ TxnTaxCodeRef: { value: 'TAX' } })
    })

    it('omits the tax detail when the invoice has no tax code', () => {
      const n = asNeutral(invoice)
      const bare = { ...invoice, TxnTaxDetail: undefined }
      expect(neutralToQbo.invoicePatch({ lines: n.lines }, bare, toSide)).not.toHaveProperty(
        'TxnTaxDetail'
      )
    })
  })

  it('builds catalogue and payment patches for the changed keys only', () => {
    expect(neutralToQbo.customerPatch({ name: 'B' })).toEqual({ DisplayName: 'B' })
    expect(neutralToQbo.accountPatch({ active: false })).toEqual({ Active: false })
    expect(neutralToQbo.itemPatch({ incomeAccount: 'account-link-9' }, toSide)).toEqual({
      IncomeAccountRef: { value: '9' },
    })
    expect(neutralToQbo.paymentPatch({ amount: '12.00', date: '2026-03-01' }, toSide)).toEqual({
      TotalAmt: 12,
      TxnDate: '2026-03-01',
    })
  })
})
