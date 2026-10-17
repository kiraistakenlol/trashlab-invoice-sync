// Behaviour of the in-memory QBO beyond the shared contract suite.
import { beforeEach, describe, expect, it } from 'vitest'
import type { QboCustomer, QboInvoice, QboPayment } from '../../src/qbo/entities.js'
import { FakeQbo } from './fake-qbo.js'

describe('FakeQbo customer renames', () => {
  let fake: FakeQbo

  const post = async <T>(entity: string, body: object): Promise<T> => {
    const res = await fake.request('POST', `/${entity.toLowerCase()}`, { body })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    return (res.body as Record<string, T>)[entity]
  }

  beforeEach(() => {
    fake = new FakeQbo()
  })

  it("a renamed customer's invoice keeps its payments and SyncToken on an unrelated update", async () => {
    const customer = await post<QboCustomer>('Customer', { DisplayName: 'old' })
    const invoice = await post<QboInvoice>('Invoice', {
      CustomerRef: { value: customer.Id },
      Line: [{ Amount: 100, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { Qty: 1 } }],
    })
    const payment = await post<QboPayment>('Payment', {
      CustomerRef: { value: customer.Id },
      TotalAmt: 40,
      Line: [{ Amount: 40, LinkedTxn: [{ TxnId: invoice.Id, TxnType: 'Invoice' }] }],
    })
    await post('Customer', {
      Id: customer.Id,
      SyncToken: customer.SyncToken,
      sparse: true,
      DisplayName: 'new',
    })

    const paid = (await fake.request('GET', `/invoice/${invoice.Id}`)).body as {
      Invoice: QboInvoice
    }
    const noOp = await post<QboInvoice>('Invoice', {
      Id: invoice.Id,
      SyncToken: paid.Invoice.SyncToken,
      sparse: true,
    })
    expect(noOp.SyncToken).toBe(paid.Invoice.SyncToken)

    const after = await post<QboInvoice>('Invoice', {
      Id: invoice.Id,
      SyncToken: paid.Invoice.SyncToken,
      sparse: true,
      PrivateNote: 'note',
    })
    expect(after.Balance).toBe(60)
    expect(after.LinkedTxn).toEqual([{ TxnId: payment.Id, TxnType: 'Payment' }])

    const samePayment = await post<QboPayment>('Payment', {
      Id: payment.Id,
      SyncToken: payment.SyncToken,
      sparse: true,
      CustomerRef: { value: customer.Id },
    })
    expect(samePayment.SyncToken).toBe(payment.SyncToken)
  })
})
