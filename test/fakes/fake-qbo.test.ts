// Behaviour of the in-memory QBO beyond the shared contract suite.
import { beforeEach, describe, expect, it } from 'vitest'
import type {
  QboAccount,
  QboCustomer,
  QboFault,
  QboDeletedStub,
  QboInvoice,
  QboItem,
  QboPayment,
  QboSalesLine,
} from '../../src/qbo/entities.js'
import type { QboWebhookEntity } from '../../src/qbo/webhooks.js'
import { FakeQbo } from './fake-qbo.js'

let fake: FakeQbo

const post = async <T>(entity: string, body: object, query?: Record<string, string>) => {
  const res = await fake.request('POST', `/${entity.toLowerCase()}`, { body, query })
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return (res.body as Record<string, T>)[entity]
}

let seq = 0

const createInvoice = async (amount = 100) => {
  const customer = await post<QboCustomer>('Customer', { DisplayName: `c${++seq}` })
  const invoice = await post<QboInvoice>('Invoice', {
    CustomerRef: { value: customer.Id },
    Line: [{ Amount: amount, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { Qty: 1 } }],
  })
  return { customer, invoice }
}

const pay = (customerId: string, invoiceId: string, amount: number) =>
  post<QboPayment>('Payment', {
    CustomerRef: { value: customerId },
    TotalAmt: amount,
    Line: [{ Amount: amount, LinkedTxn: [{ TxnId: invoiceId, TxnType: 'Invoice' }] }],
  })

const events = (es: QboWebhookEntity[]) => es.map((e) => [e.name, e.id, e.operation])

const invoiceCount = async () => {
  const res = await fake.query('select * from Invoice')
  return ((res.body as { QueryResponse: { Invoice?: unknown[] } }).QueryResponse.Invoice ?? [])
    .length
}

beforeEach(() => {
  fake = new FakeQbo()
})

describe('FakeQbo accounts and items', () => {
  it('creates an income account and an item posting to it', async () => {
    const account = await post<QboAccount>('Account', { Name: 'Hauling', AccountType: 'Income' })
    expect(account).toMatchObject({ Name: 'Hauling', AccountType: 'Income', Active: true })
    const item = await post<QboItem>('Item', {
      Name: 'Pickup',
      Type: 'Service',
      IncomeAccountRef: { value: account.Id },
    })
    expect(item).toMatchObject({
      Name: 'Pickup',
      Type: 'Service',
      Active: true,
      IncomeAccountRef: { value: account.Id, name: 'Hauling' },
    })
    expect(events(fake.takeWebhooks())).toEqual([
      ['Account', account.Id, 'Create'],
      ['Item', item.Id, 'Create'],
    ])
  })

  it('rejects a duplicate name ignoring case (6240), a missing type (2170), an unknown account (2500)', async () => {
    const codes = async (entity: string, body: object) => {
      const res = await fake.request('POST', `/${entity.toLowerCase()}`, { body })
      return (res.body as QboFault).Fault.Error.map((e) => e.code)
    }
    expect(await codes('Account', { Name: 'SERVICES', AccountType: 'Income' })).toEqual(['6240'])
    expect(await codes('Account', { Name: 'Other' })).toEqual(['2170'])
    expect(await codes('Item', { Name: 'services', IncomeAccountRef: { value: '1' } })).toEqual([
      '6240',
    ])
    expect(await codes('Item', { Name: 'New', IncomeAccountRef: { value: '999' } })).toEqual([
      '2500',
    ])
  })
})

describe('FakeQbo customer renames', () => {
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

describe('FakeQbo webhooks', () => {
  it('emits Create, Update, Void, Delete webhooks for invoice writes', async () => {
    const { customer, invoice } = await createInvoice()
    const updated = await post<QboInvoice>('Invoice', {
      Id: invoice.Id,
      SyncToken: invoice.SyncToken,
      sparse: true,
      PrivateNote: 'changed',
    })
    const voided = await post<QboInvoice>(
      'Invoice',
      { Id: invoice.Id, SyncToken: updated.SyncToken },
      { operation: 'void' }
    )
    await post('Invoice', { Id: invoice.Id, SyncToken: voided.SyncToken }, { operation: 'delete' })

    const delivered = fake.takeWebhooks()
    expect(events(delivered)).toEqual([
      ['Customer', customer.Id, 'Create'],
      ['Invoice', invoice.Id, 'Create'],
      ['Invoice', invoice.Id, 'Update'],
      ['Invoice', invoice.Id, 'Void'],
      ['Invoice', invoice.Id, 'Delete'],
    ])
    expect(delivered[1].lastUpdated).toBe(new Date(invoice.MetaData.LastUpdatedTime).toISOString())
    expect(fake.takeWebhooks()).toEqual([])
  })

  it('a payment emits only a Payment event', async () => {
    const { customer, invoice } = await createInvoice()
    fake.takeWebhooks()
    const payment = await pay(customer.Id, invoice.Id, 40)
    expect(events(fake.takeWebhooks())).toEqual([['Payment', payment.Id, 'Create']])
  })

  it('a no-op update emits nothing', async () => {
    const { invoice } = await createInvoice()
    fake.takeWebhooks()
    await post('Invoice', { Id: invoice.Id, SyncToken: invoice.SyncToken, sparse: true })
    expect(fake.takeWebhooks()).toEqual([])
  })

  it('takeWebhooks can duplicate, reverse and drop', async () => {
    const a = await createInvoice()
    const b = await createInvoice()
    const delivered = fake.takeWebhooks({
      drop: (e) => e.name === 'Customer',
      duplicate: true,
      reverse: true,
    })
    expect(events(delivered)).toEqual([
      ['Invoice', b.invoice.Id, 'Create'],
      ['Invoice', b.invoice.Id, 'Create'],
      ['Invoice', a.invoice.Id, 'Create'],
      ['Invoice', a.invoice.Id, 'Create'],
    ])
    expect(fake.takeWebhooks()).toEqual([])
  })
})

describe('FakeQbo change data capture', () => {
  it('CDC includes an invoice changed only by a payment', async () => {
    let clock = new Date('2026-10-17T10:00:00Z')
    fake = new FakeQbo({ now: () => clock })
    const { customer, invoice } = await createInvoice()
    clock = new Date('2026-10-17T10:00:05Z')
    const payment = await pay(customer.Id, invoice.Id, 40)

    const res = await fake.request('GET', '/cdc', {
      query: { entities: 'Invoice,Payment', changedSince: '2026-10-17T10:00:01Z' },
    })
    const groups = (res.body as { CDCResponse: { QueryResponse: object[] }[] }).CDCResponse[0]
      .QueryResponse
    expect(groups).toEqual([
      expect.objectContaining({ Invoice: [expect.objectContaining({ Id: invoice.Id })] }),
      expect.objectContaining({ Payment: [expect.objectContaining({ Id: payment.Id })] }),
    ])
  })

  it('CDC lists live records by LastUpdatedTime, then deleted stubs', async () => {
    let clock = new Date('2026-10-17T10:00:00Z')
    fake = new FakeQbo({ now: () => clock })
    const a = await createInvoice()
    const b = await createInvoice()
    const c = await createInvoice()
    clock = new Date('2026-10-17T10:00:05Z')
    await post('Invoice', { Id: c.invoice.Id, SyncToken: '0' }, { operation: 'delete' })
    await post('Invoice', { Id: a.invoice.Id, SyncToken: '0', sparse: true, PrivateNote: 'n' })

    const res = await fake.request('GET', '/cdc', {
      query: { entities: 'Invoice', changedSince: '2026-10-17' },
    })
    const [group] = (
      res.body as {
        CDCResponse: { QueryResponse: { Invoice: (QboInvoice | QboDeletedStub)[] }[] }[]
      }
    ).CDCResponse[0].QueryResponse
    expect(group.Invoice.map((e) => [e.Id, 'status' in e])).toEqual([
      [b.invoice.Id, false],
      [a.invoice.Id, false],
      [c.invoice.Id, true],
    ])
  })
})

describe('FakeQbo failure injection', () => {
  it('timeout after write applies the create and a requestid retry returns it', async () => {
    const { customer } = await createInvoice()
    expect(await invoiceCount()).toBe(1)
    fake.takeWebhooks()
    fake.failNext({ method: 'POST', path: '/invoice' }, 'timeout_after_write')
    const body = {
      CustomerRef: { value: customer.Id },
      Line: [{ Amount: 10, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { Qty: 1 } }],
    }
    const send = () => fake.request('POST', '/invoice', { body, requestId: 'key-1' })

    await expect(send()).rejects.toMatchObject({ name: 'TimeoutError' })
    const retry = await send()
    expect(retry.status).toBe(200)
    const created = (retry.body as { Invoice: QboInvoice }).Invoice
    expect(events(fake.takeWebhooks())).toEqual([['Invoice', created.Id, 'Create']])
    expect(await invoiceCount()).toBe(2)
  })

  it('http_429 carries retry-after and writes nothing', async () => {
    const { customer } = await createInvoice()
    fake.takeWebhooks()
    fake.failNext({ path: '/invoice' }, 'http_429')
    const res = await fake.request('POST', '/invoice', {
      body: { CustomerRef: { value: customer.Id }, Line: [] },
    })
    expect(res.status).toBe(429)
    expect(res.headers['retry-after']).toBe('1')
    expect(await invoiceCount()).toBe(1)
    expect(fake.takeWebhooks()).toEqual([])
  })

  it('http_400 is a validation fault and writes nothing', async () => {
    const { customer } = await createInvoice()
    fake.takeWebhooks()
    fake.failNext({ method: 'POST', path: '/invoice' }, 'http_400')
    const res = await fake.request('POST', '/invoice', {
      body: { CustomerRef: { value: customer.Id }, Line: [] },
    })
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({
      Fault: { Error: [{ code: '2050' }], type: 'ValidationFault' },
    })
    expect(await invoiceCount()).toBe(1)
    expect(fake.takeWebhooks()).toEqual([])
  })

  it('http_401 uses the lowercase fault envelope', async () => {
    fake.failNext({}, 'http_401')
    const res = await fake.query('select * from Invoice')
    expect(res.status).toBe(401)
    expect(res.headers['www-authenticate']).toContain('invalid_token')
    expect(res.body).toMatchObject({
      fault: { error: [{ code: '3200' }], type: 'AUTHENTICATION' },
    })
  })

  it('failNext matches method and path prefix, once and in order', async () => {
    const { invoice } = await createInvoice()
    fake.failNext({ method: 'POST', path: '/invoice' }, 'http_500')
    fake.failNext({ path: '/invoice' }, 'unavailable')
    expect((await fake.request('GET', `/invoice/${invoice.Id}`)).status).toBe(503)
    expect((await fake.request('GET', `/invoice/${invoice.Id}`)).status).toBe(200)
    expect((await fake.query('select * from Invoice')).status).toBe(200)
    const res = await fake.request('POST', '/invoice', { body: {} })
    expect(res.status).toBe(500)
    expect(res.body).toHaveProperty('Fault')
  })

  it('timeout before write and http_425 write nothing', async () => {
    const { customer } = await createInvoice()
    const body = {
      CustomerRef: { value: customer.Id },
      Line: [{ Amount: 10, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { Qty: 1 } }],
    }
    fake.failNext({ path: '/invoice' }, 'timeout_before_write')
    fake.failNext({ path: '/invoice' }, 'http_425')
    await expect(fake.request('POST', '/invoice', { body })).rejects.toMatchObject({
      name: 'TimeoutError',
    })
    const busy = await fake.request('POST', '/invoice', { body })
    expect(busy.status).toBe(425)
    expect(busy.body).toBe('')
    expect(await invoiceCount()).toBe(1)
  })
})

describe('FakeQbo UI edits', () => {
  it('uiSaveInvoice taxes a 15.00 invoice at 1.20', async () => {
    const { invoice } = await createInvoice(15)
    fake.takeWebhooks()
    fake.uiSaveInvoice(invoice.Id)
    const res = await fake.request('GET', `/invoice/${invoice.Id}`)
    const saved = (res.body as { Invoice: QboInvoice }).Invoice
    expect(saved.TxnTaxDetail).toMatchObject({ TxnTaxCodeRef: { value: '2' }, TotalTax: 1.2 })
    expect(saved.TotalAmt).toBe(16.2)
    expect(saved.Balance).toBe(16.2)
    expect(saved.SyncToken).toBe('1')
    const lines = saved.Line.filter(
      (l): l is QboSalesLine => l.DetailType === 'SalesItemLineDetail'
    )
    expect(lines.map((l) => l.SalesItemLineDetail.TaxCodeRef?.value)).toEqual(['NON'])
    expect(events(fake.takeWebhooks())).toEqual([['Invoice', invoice.Id, 'Update']])
  })
})
