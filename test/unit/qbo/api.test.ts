import { beforeEach, describe, expect, it } from 'vitest'
import { QboApi, QboApiError } from '../../../src/qbo/api.js'
import type { QboCustomer, QboInvoice } from '../../../src/qbo/entities.js'
import { FakeQbo } from '../../fakes/fake-qbo.js'

let fake: FakeQbo
let api: QboApi

const line = (amount: number) => ({
  Amount: amount,
  DetailType: 'SalesItemLineDetail',
  SalesItemLineDetail: { ItemRef: { value: '1' } },
})

let seq = 0

const newInvoice = async (): Promise<QboInvoice> => {
  const n = ++seq
  const customer = await api.create('Customer', { DisplayName: `Acme ${n}` }, `rq-customer-${n}`)
  return api.create(
    'Invoice',
    { CustomerRef: { value: customer.Id }, Line: [line(10)] },
    `rq-inv-${n}`
  )
}

const failure = async (run: Promise<unknown>): Promise<QboApiError> => {
  const error = await run.then(
    () => null,
    (e: unknown) => e
  )
  expect(error).toBeInstanceOf(QboApiError)
  return error as QboApiError
}

beforeEach(() => {
  fake = new FakeQbo()
  api = new QboApi(fake)
})

describe('QboApi', () => {
  it('get of an unknown id is null', async () => {
    expect(await api.get('Invoice', '999999')).toBeNull()
  })

  it('get returns the entity', async () => {
    const invoice = await newInvoice()
    expect((await api.get('Invoice', invoice.Id))?.Id).toBe(invoice.Id)
  })

  it('a stale update fails with 5010', async () => {
    const invoice = await newInvoice()
    const stale = { Id: invoice.Id, SyncToken: invoice.SyncToken }
    await api.update('Invoice', { ...stale, PrivateNote: 'first' })
    const error = await failure(api.update('Invoice', { ...stale, PrivateNote: 'second' }))
    expect(error.codes).toEqual(['5010'])
    expect(error.status).toBe(400)
  })

  it('create with the same requestId twice makes one record', async () => {
    const customer = await api.create('Customer', { DisplayName: 'Acme' }, 'rq-c')
    const body = { CustomerRef: { value: customer.Id }, Line: [line(10)] }
    const a = await api.create('Invoice', body, 'rq-same')
    const b = await api.create('Invoice', body, 'rq-same')
    expect(b.Id).toBe(a.Id)
    const all = await fake.query('select * from Invoice')
    expect(
      (all.body as { QueryResponse: { Invoice: unknown[] } }).QueryResponse.Invoice
    ).toHaveLength(1)
  })

  it('void zeroes the invoice', async () => {
    const invoice = await newInvoice()
    const voided = await api.voidInvoice(invoice.Id, invoice.SyncToken)
    expect(voided.TotalAmt).toBe(0)
  })

  it('remove deletes the invoice', async () => {
    const invoice = await newInvoice()
    await api.remove('Invoice', invoice.Id, invoice.SyncToken)
    expect(await api.get('Invoice', invoice.Id)).toBeNull()
  })

  it('findByName matches ignoring case and escapes quotes', async () => {
    await api.create('Customer', { DisplayName: "O'Brien" }, 'rq-ob')
    const found = await api.findByName('Customer', "o'brien")
    expect(found.map((c: QboCustomer) => c.DisplayName)).toEqual(["O'Brien"])
    expect(await api.findByName('Customer', 'nobody')).toEqual([])
  })

  it('findInvoicesByNumber finds by DocNumber', async () => {
    const customer = await api.create('Customer', { DisplayName: 'Acme' }, 'rq-c')
    const body = { CustomerRef: { value: customer.Id }, Line: [line(10)], DocNumber: 'INV-1' }
    const invoice = await api.create('Invoice', body, 'rq-n')
    expect((await api.findInvoicesByNumber('INV-1')).map((i) => i.Id)).toEqual([invoice.Id])
  })

  it('changes flags a deleted stub', async () => {
    const live = await newInvoice()
    const gone = await newInvoice()
    await api.remove('Invoice', gone.Id, gone.SyncToken)
    const { changes, capped } = await api.changes(['Invoice'], '2000-01-01T00:00:00Z')
    expect(capped).toEqual([])
    expect(changes).toContainEqual(expect.objectContaining({ id: live.Id, deleted: false }))
    expect(changes).toContainEqual(
      expect.objectContaining({ entity: 'Invoice', id: gone.Id, deleted: true })
    )
  })

  it('an armed 429 carries retryAfterMs', async () => {
    fake.failNext({ method: 'GET' }, 'http_429')
    const error = await failure(api.get('Invoice', '1'))
    expect(error).toMatchObject({ status: 429, codes: ['3001'], retryAfterMs: 1000 })
  })

  it('an armed 500 has no retryAfterMs', async () => {
    fake.failNext({ method: 'GET' }, 'http_500')
    expect(await failure(api.get('Invoice', '1'))).toMatchObject({
      status: 500,
      retryAfterMs: null,
    })
  })

  it('an armed 425 has an empty body and no codes', async () => {
    fake.failNext({ method: 'POST' }, 'http_425')
    const error = await failure(api.create('Customer', { DisplayName: 'x' }, 'rq'))
    expect(error).toMatchObject({ status: 425, codes: [] })
  })

  it('a Fault with HTTP 200 is an error', async () => {
    const client = {
      request: async () => ({
        status: 200,
        intuitTid: 't1',
        headers: {},
        body: { Fault: { Error: [{ code: '10000', Message: 'm' }], type: 'SystemFault' } },
      }),
      query: async () => {
        throw new Error('unused')
      },
    }
    const error = await failure(new QboApi(client).changes(['Invoice'], '2000-01-01T00:00:00Z'))
    expect(error).toMatchObject({ status: 200, codes: ['10000'], intuitTid: 't1' })
  })
})
