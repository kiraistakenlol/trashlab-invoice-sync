// QBO behaviour the sync relies on, as one suite runnable against any QboClient.
import { afterAll, describe, expect, it } from 'vitest'
import type { QboClient, QboResponse } from '../../src/qbo/client.js'
import type {
  QboCustomer,
  QboDeletedStub,
  QboEntityName,
  QboFault,
  QboInvoice,
  QboPayment,
  QboSalesLine,
} from '../../src/qbo/entities.js'

export interface QboContractOptions {
  client: () => QboClient
  prefix: string // makes created names and DocNumbers unique to the run; keep it short
  settle: <T>(read: () => Promise<T>, ok: (v: T) => boolean) => Promise<T>
  cleanup?: boolean // delete payments and invoices, deactivate customers created by the suite
}

const ITEM_SERVICES = '1'
const UNKNOWN_ID = '999999999'
const SALES_TAX_CODE = '2'
const TAXED = { TxnTaxDetail: { TxnTaxCodeRef: { value: SALES_TAX_CODE } } }

interface LineSpec {
  amount: number
  itemId?: string
  taxCode?: 'TAX' | 'NON'
}

type CdcEntry = QboInvoice | QboDeletedStub

interface Application {
  invoiceId: string
  amount: number
}

const invoiceBody = (customerId: string, lines: LineSpec[], extra: object = {}) => ({
  CustomerRef: { value: customerId },
  Line: lines.map((l) => ({
    Amount: l.amount,
    DetailType: 'SalesItemLineDetail',
    SalesItemLineDetail: {
      ItemRef: { value: l.itemId ?? ITEM_SERVICES },
      ...(l.taxCode ? { TaxCodeRef: { value: l.taxCode } } : {}),
    },
  })),
  ...extra,
})

const salesLines = (inv: QboInvoice): QboSalesLine[] =>
  inv.Line.filter((l): l is QboSalesLine => l.DetailType === 'SalesItemLineDetail')

const secondsBefore = (time: string, seconds: number): string =>
  new Date(Date.parse(time) - seconds * 1000).toISOString()

const expectFault = (res: QboResponse, code: string): void => {
  expect(res.status).toBe(400)
  expect((res.body as QboFault).Fault.Error.map((e) => e.code)).toContain(code)
}

export function qboContract(opts: QboContractOptions): void {
  const { client, prefix, settle } = opts
  const created = { payments: [] as string[], invoices: [] as string[], customers: [] as string[] }
  let seq = 0
  const unique = (label: string) => `${prefix}-${label}${++seq}`

  const entityOf = <T>(res: QboResponse, entity: QboEntityName): T => {
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    return (res.body as Record<string, T>)[entity]
  }

  const get = (entity: QboEntityName, id: string) =>
    client().request('GET', `/${entity.toLowerCase()}/${id}`)

  const post = (
    entity: QboEntityName,
    body: object,
    options: { query?: Record<string, string>; requestId?: string } = {}
  ) => client().request('POST', `/${entity.toLowerCase()}`, { body, ...options })

  const update = (entity: QboEntityName, body: object, requestId?: string) =>
    post(entity, { ...body, sparse: true }, { requestId })

  const remove = (entity: QboEntityName, body: object) =>
    post(entity, body, { query: { operation: 'delete' } })

  const postCustomer = (name: string) =>
    client().request('POST', '/customer', { body: { DisplayName: name } })

  const createCustomer = async (name = unique('c')): Promise<QboCustomer> => {
    const customer = entityOf<QboCustomer>(await postCustomer(name), 'Customer')
    created.customers.push(customer.Id)
    return customer
  }

  const createInvoice = async (
    customerId: string,
    lines: LineSpec[],
    extra?: object
  ): Promise<QboInvoice> => {
    const res = await client().request('POST', '/invoice', {
      body: invoiceBody(customerId, lines, extra),
    })
    const invoice = entityOf<QboInvoice>(res, 'Invoice')
    created.invoices.push(invoice.Id)
    return invoice
  }

  const createPayment = async (
    customerId: string,
    total: number,
    applications: Application[]
  ): Promise<QboPayment> => {
    const res = await post('Payment', {
      CustomerRef: { value: customerId },
      TotalAmt: total,
      Line: applications.map((a) => ({
        Amount: a.amount,
        LinkedTxn: [{ TxnId: a.invoiceId, TxnType: 'Invoice' }],
      })),
    })
    const payment = entityOf<QboPayment>(res, 'Payment')
    created.payments.push(payment.Id)
    return payment
  }

  const readInvoice = async (id: string) =>
    entityOf<QboInvoice>(await get('Invoice', id), 'Invoice')
  const readPayment = async (id: string) =>
    entityOf<QboPayment>(await get('Payment', id), 'Payment')

  const queryInvoices = async (where: string): Promise<QboInvoice[]> => {
    const res = await client().query(`select * from Invoice where ${where}`)
    expect(res.status).toBe(200)
    return (res.body as { QueryResponse: { Invoice?: QboInvoice[] } }).QueryResponse.Invoice ?? []
  }

  const cdcInvoices = async (changedSince: string): Promise<CdcEntry[]> => {
    const res = await client().request('GET', '/cdc', {
      query: { entities: 'Invoice', changedSince },
    })
    expect(res.status).toBe(200)
    expect(res.body).not.toHaveProperty('Fault')
    const [cdc] = (res.body as { CDCResponse: { QueryResponse: { Invoice?: CdcEntry[] }[] }[] })
      .CDCResponse
    return cdc.QueryResponse.flatMap((group) => group.Invoice ?? [])
  }

  const ids = (entries: CdcEntry[]) => entries.map((e) => e.Id)

  afterAll(async () => {
    if (!opts.cleanup) return
    const failures: string[] = []
    const check = (what: string, res: QboResponse) => {
      if (res.status !== 200) failures.push(`${what}: ${res.status} ${JSON.stringify(res.body)}`)
    }
    for (const [entity, ids] of [
      ['Payment', created.payments],
      ['Invoice', created.invoices],
    ] as const) {
      for (const id of ids) {
        const res = await get(entity, id)
        if (res.status !== 200) continue // deleted by its test
        const { SyncToken } = (res.body as Record<string, { SyncToken: string }>)[entity]
        check(`delete ${entity} ${id}`, await remove(entity, { Id: id, SyncToken }))
      }
    }
    for (const id of created.customers) {
      const customer = entityOf<QboCustomer>(await get('Customer', id), 'Customer')
      check(
        `deactivate Customer ${id}`,
        await update('Customer', { Id: id, SyncToken: customer.SyncToken, Active: false })
      )
    }
    expect(failures, 'cleanup left records behind').toEqual([])
  })

  describe('QBO records', () => {
    it('GET of an unknown id is 610', async () => {
      expectFault(await get('Invoice', UNKNOWN_ID), '610')
    })

    it('a create returns SyncToken "0" and the computed total', async () => {
      const customer = await createCustomer()
      const invoice = await createInvoice(customer.Id, [{ amount: 10 }, { amount: 20 }])
      expect(invoice.SyncToken).toBe('0')
      expect(invoice.TotalAmt).toBe(30)
      expect(invoice.Balance).toBe(30)
      expect(invoice.Line).toContainEqual(
        expect.objectContaining({ DetailType: 'SubTotalLineDetail', Amount: 30 })
      )
    })

    it('a no-op sparse update keeps SyncToken', async () => {
      const customer = await createCustomer()
      const invoice = await createInvoice(customer.Id, [{ amount: 10 }], { PrivateNote: 'n' })
      const res = await update('Invoice', {
        Id: invoice.Id,
        SyncToken: invoice.SyncToken,
        PrivateNote: 'n',
      })
      const after = entityOf<QboInvoice>(res, 'Invoice')
      expect(after.SyncToken).toBe(invoice.SyncToken)
      expect(after.MetaData.LastUpdatedTime).toBe(invoice.MetaData.LastUpdatedTime)
    })

    it('a real sparse update bumps SyncToken by one', async () => {
      const customer = await createCustomer()
      const invoice = await createInvoice(customer.Id, [{ amount: 10 }])
      const res = await update('Invoice', {
        Id: invoice.Id,
        SyncToken: invoice.SyncToken,
        PrivateNote: 'changed',
      })
      const after = entityOf<QboInvoice>(res, 'Invoice')
      expect(Number(after.SyncToken)).toBe(Number(invoice.SyncToken) + 1)
      expect(after.PrivateNote).toBe('changed')
      const read = entityOf<QboInvoice>(await get('Invoice', invoice.Id), 'Invoice')
      expect(read.SyncToken).toBe(after.SyncToken)
    })

    it('a stale SyncToken is rejected with 5010', async () => {
      const customer = await createCustomer()
      const invoice = await createInvoice(customer.Id, [{ amount: 10 }])
      const stale = { Id: invoice.Id, SyncToken: invoice.SyncToken }
      entityOf(await update('Invoice', { ...stale, PrivateNote: 'first' }), 'Invoice')
      expectFault(await update('Invoice', { ...stale, PrivateNote: 'second' }), '5010')
      const read = entityOf<QboInvoice>(await get('Invoice', invoice.Id), 'Invoice')
      expect(read.PrivateNote).toBe('first')
    })

    it('sparse Line replaces all lines', async () => {
      const customer = await createCustomer()
      const invoice = await createInvoice(customer.Id, [{ amount: 10 }, { amount: 20 }])
      const second = salesLines(invoice)[1]
      const res = await update('Invoice', {
        Id: invoice.Id,
        SyncToken: invoice.SyncToken,
        Line: [second],
      })
      const after = entityOf<QboInvoice>(res, 'Invoice')
      expect(salesLines(after).map((l) => [l.Id, l.Amount])).toEqual([[second.Id, 20]])
      expect(after.TotalAmt).toBe(20)
    })

    it('DocNumber is not unique; a query by DocNumber returns both', async () => {
      const customer = await createCustomer()
      const docNumber = unique('d')
      const a = await createInvoice(customer.Id, [{ amount: 10 }], {
        DocNumber: docNumber.toUpperCase(),
      })
      const b = await createInvoice(customer.Id, [{ amount: 20 }], {
        DocNumber: docNumber.toUpperCase(),
      })
      const found = await settle(
        () => queryInvoices(`DocNumber = '${docNumber}'`),
        (rows) => rows.length === 2
      )
      expect(found.map((i) => i.Id).sort()).toEqual([a.Id, b.Id].sort())
    })

    it('customer DisplayName is unique ignoring case (6240)', async () => {
      const name = unique('dup')
      await createCustomer(name)
      expectFault(await postCustomer(name.toUpperCase()), '6240')
    })

    it('a line without SalesItemLineDetail is rejected (2020)', async () => {
      const customer = await createCustomer()
      const res = await post('Invoice', {
        CustomerRef: { value: customer.Id },
        Line: [{ Amount: 10, DetailType: 'SalesItemLineDetail' }],
      })
      expectFault(res, '2020')
    })

    it('an invoice for an unknown item is rejected (2500) and nothing is written', async () => {
      const customer = await createCustomer()
      const docNumber = unique('x')
      const res = await client().request('POST', '/invoice', {
        body: invoiceBody(customer.Id, [{ amount: 10, itemId: UNKNOWN_ID }], {
          DocNumber: docNumber,
        }),
      })
      expectFault(res, '2500')
      expect(await queryInvoices(`DocNumber = '${docNumber}'`)).toEqual([])
    })
  })

  describe('QBO requestid', () => {
    it('a create replayed with the same requestid returns the first record and ignores the new body', async () => {
      const customer = await createCustomer()
      const key = unique('rq')
      const [first, second] = [unique('d'), unique('d')]
      const a = await post(
        'Invoice',
        invoiceBody(customer.Id, [{ amount: 10 }], { DocNumber: first }),
        {
          requestId: key,
        }
      )
      const created1 = entityOf<QboInvoice>(a, 'Invoice')
      created.invoices.push(created1.Id)
      const b = await post(
        'Invoice',
        invoiceBody(customer.Id, [{ amount: 20 }], { DocNumber: second }),
        {
          requestId: key,
        }
      )
      const replayed = entityOf<QboInvoice>(b, 'Invoice')
      expect(replayed.Id).toBe(created1.Id)
      expect(replayed.DocNumber).toBe(first)
      const found = await settle(
        () => queryInvoices(`DocNumber = '${first}'`),
        (rows) => rows.length === 1
      )
      expect(found).toHaveLength(1)
      expect(await queryInvoices(`DocNumber = '${second}'`)).toEqual([])
    })

    it('a requestid replay on an update returns the stored response even with a stale SyncToken', async () => {
      const customer = await createCustomer()
      const invoice = await createInvoice(customer.Id, [{ amount: 10 }])
      const body = { Id: invoice.Id, SyncToken: invoice.SyncToken, PrivateNote: 'once' }
      const key = unique('rq')
      const first = await update('Invoice', body, key)
      expect(entityOf<QboInvoice>(first, 'Invoice').SyncToken).toBe('1')
      const replay = await update('Invoice', body, key)
      expect(replay.status).toBe(200)
      expect(replay.body).toEqual(first.body)
      expectFault(await update('Invoice', body), '5010')
    })
  })

  describe('QBO void and delete', () => {
    it('void zeroes the invoice and prefixes PrivateNote with "Voided - "', async () => {
      const customer = await createCustomer()
      const invoice = await createInvoice(customer.Id, [{ amount: 10 }, { amount: 20 }], {
        PrivateNote: 'note',
      })
      const res = await post(
        'Invoice',
        { Id: invoice.Id, SyncToken: invoice.SyncToken },
        { query: { operation: 'void' } }
      )
      const voided = entityOf<QboInvoice>(res, 'Invoice')
      expect(voided.TotalAmt).toBe(0)
      expect(voided.Balance).toBe(0)
      expect(salesLines(voided).map((l) => l.Amount)).toEqual([0, 0])
      expect(voided.PrivateNote).toBe('Voided - note')
      expect(Number(voided.SyncToken)).toBe(Number(invoice.SyncToken) + 1)
    })

    it("void unapplies the invoice's payment", async () => {
      const customer = await createCustomer()
      const invoice = await createInvoice(customer.Id, [{ amount: 100 }])
      const payment = await createPayment(customer.Id, 40, [{ invoiceId: invoice.Id, amount: 40 }])
      const paid = await readInvoice(invoice.Id)
      entityOf(
        await post(
          'Invoice',
          { Id: invoice.Id, SyncToken: paid.SyncToken },
          { query: { operation: 'void' } }
        ),
        'Invoice'
      )
      const after = await readPayment(payment.Id)
      expect(after.UnappliedAmt).toBe(40)
      expect(after.Line).toEqual([])
      expect((await readInvoice(invoice.Id)).LinkedTxn).toEqual([])
    })

    it('delete ignores a stale SyncToken; GET afterwards is 610', async () => {
      const customer = await createCustomer()
      const invoice = await createInvoice(customer.Id, [{ amount: 10 }])
      const stale = { Id: invoice.Id, SyncToken: invoice.SyncToken }
      entityOf(await update('Invoice', { ...stale, PrivateNote: 'bump' }), 'Invoice')
      const res = await remove('Invoice', stale)
      expect(entityOf<QboDeletedStub>(res, 'Invoice')).toMatchObject({
        status: 'Deleted',
        Id: invoice.Id,
      })
      expectFault(await get('Invoice', invoice.Id), '610')
    })
  })

  describe('QBO payments', () => {
    it('a payment applies to an invoice and bumps its SyncToken', async () => {
      const customer = await createCustomer()
      const invoice = await createInvoice(customer.Id, [{ amount: 100 }])
      const payment = await createPayment(customer.Id, 40, [{ invoiceId: invoice.Id, amount: 40 }])
      expect(payment.UnappliedAmt).toBe(0)
      const after = await readInvoice(invoice.Id)
      expect(after.Balance).toBe(60)
      expect(after.LinkedTxn).toContainEqual({ TxnId: payment.Id, TxnType: 'Payment' })
      expect(Number(after.SyncToken)).toBe(Number(invoice.SyncToken) + 1)
    })

    it('one payment applies 60 / 40 over two invoices', async () => {
      const customer = await createCustomer()
      const a = await createInvoice(customer.Id, [{ amount: 60 }])
      const b = await createInvoice(customer.Id, [{ amount: 40 }])
      const payment = await createPayment(customer.Id, 100, [
        { invoiceId: a.Id, amount: 60 },
        { invoiceId: b.Id, amount: 40 },
      ])
      expect(payment.UnappliedAmt).toBe(0)
      expect((await readInvoice(a.Id)).Balance).toBe(0)
      expect((await readInvoice(b.Id)).Balance).toBe(0)
    })

    it('reducing a paid invoice below the paid amount shrinks the application', async () => {
      const customer = await createCustomer()
      const invoice = await createInvoice(customer.Id, [{ amount: 100 }])
      const payment = await createPayment(customer.Id, 100, [
        { invoiceId: invoice.Id, amount: 100 },
      ])
      const paid = await readInvoice(invoice.Id)
      const res = await update('Invoice', {
        Id: invoice.Id,
        SyncToken: paid.SyncToken,
        Line: [{ ...salesLines(paid)[0], Amount: 70 }],
      })
      const after = entityOf<QboInvoice>(res, 'Invoice')
      expect(after.TotalAmt).toBe(70)
      expect(after.Balance).toBe(0)
      const shrunk = await readPayment(payment.Id)
      expect(shrunk.Line.map((l) => l.Amount)).toEqual([70])
      expect(shrunk.UnappliedAmt).toBe(30)
    })

    it('a payment void restores the invoice balance', async () => {
      const customer = await createCustomer()
      const invoice = await createInvoice(customer.Id, [{ amount: 100 }])
      const payment = await createPayment(customer.Id, 40, [{ invoiceId: invoice.Id, amount: 40 }])
      const res = await post(
        'Payment',
        { Id: payment.Id, SyncToken: payment.SyncToken, sparse: true },
        { query: { operation: 'update', include: 'void' } }
      )
      const voided = entityOf<QboPayment>(res, 'Payment')
      expect(voided).toMatchObject({ TotalAmt: 0, Line: [], PrivateNote: 'Voided' })
      const after = await readInvoice(invoice.Id)
      expect(after.Balance).toBe(100)
      expect(after.LinkedTxn).toEqual([])
    })
  })

  describe('QBO change data capture', () => {
    it('CDC returns each changed record once in its current state', async () => {
      const customer = await createCustomer()
      const invoice = await createInvoice(customer.Id, [{ amount: 10 }])
      let { SyncToken } = invoice
      for (const PrivateNote of ['first', 'second']) {
        const res = await update('Invoice', { Id: invoice.Id, SyncToken, PrivateNote })
        SyncToken = entityOf<QboInvoice>(res, 'Invoice').SyncToken
      }
      const since = secondsBefore(invoice.MetaData.CreateTime, 1)
      const entries = await settle(
        async () => (await cdcInvoices(since)).filter((e) => e.Id === invoice.Id),
        (found) => found.some((e) => 'SyncToken' in e && e.SyncToken === '2')
      )
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({ SyncToken: '2', PrivateNote: 'second' })
    })

    it('CDC returns a Deleted stub for a deleted invoice', async () => {
      const customer = await createCustomer()
      const invoice = await createInvoice(customer.Id, [{ amount: 10 }])
      entityOf(await remove('Invoice', { Id: invoice.Id, SyncToken: invoice.SyncToken }), 'Invoice')
      const since = secondsBefore(invoice.MetaData.CreateTime, 1)
      const entries = await settle(
        async () => (await cdcInvoices(since)).filter((e) => e.Id === invoice.Id),
        (found) => found.some((e) => 'status' in e)
      )
      expect(entries).toEqual([expect.objectContaining({ status: 'Deleted', Id: invoice.Id })])
    })

    it('CDC changedSince is exclusive', async () => {
      const customer = await createCustomer()
      const invoice = await createInvoice(customer.Id, [{ amount: 10 }])
      const t = invoice.MetaData.LastUpdatedTime
      const before = await settle(
        () => cdcInvoices(secondsBefore(t, 1)),
        (found) => ids(found).includes(invoice.Id)
      )
      expect(ids(before)).toContain(invoice.Id)
      expect(ids(await cdcInvoices(t))).not.toContain(invoice.Id)
    })
  })

  describe('QBO sales tax', () => {
    it('computes 8 % tax when both tax codes are sent', async () => {
      const customer = await createCustomer()
      const invoice = await createInvoice(customer.Id, [{ amount: 100, taxCode: 'TAX' }], TAXED)
      expect(invoice.TxnTaxDetail).toMatchObject({
        TxnTaxCodeRef: { value: SALES_TAX_CODE },
        TotalTax: 8,
      })
      expect(invoice.TotalAmt).toBe(108)
      expect(invoice.Balance).toBe(108)
    })

    it('a line update on a taxed invoice without TxnTaxCodeRef fails with 6000', async () => {
      const customer = await createCustomer()
      const invoice = await createInvoice(customer.Id, [{ amount: 100, taxCode: 'TAX' }], TAXED)
      const res = await update('Invoice', {
        Id: invoice.Id,
        SyncToken: invoice.SyncToken,
        Line: salesLines(invoice),
      })
      expectFault(res, '6000')
    })

    it('a line update with TxnTaxCodeRef and NON lines drops the tax', async () => {
      const customer = await createCustomer()
      const invoice = await createInvoice(customer.Id, [{ amount: 100, taxCode: 'TAX' }], TAXED)
      const Line = salesLines(invoice).map((l) => ({
        ...l,
        SalesItemLineDetail: { ...l.SalesItemLineDetail, TaxCodeRef: { value: 'NON' } },
      }))
      const res = await update('Invoice', {
        Id: invoice.Id,
        SyncToken: invoice.SyncToken,
        Line,
        ...TAXED,
      })
      const after = entityOf<QboInvoice>(res, 'Invoice')
      expect(after.TxnTaxDetail?.TotalTax).toBe(0)
      expect(after.TxnTaxDetail?.TxnTaxCodeRef).toBeUndefined()
      expect(after.TotalAmt).toBe(100)
    })
  })
}
