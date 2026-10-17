// QBO behaviour the sync relies on, as one suite runnable against any QboClient.
import { afterAll, describe, expect, it } from 'vitest'
import type { QboClient, QboResponse } from '../../src/qbo/client.js'
import type {
  QboCustomer,
  QboEntityName,
  QboFault,
  QboInvoice,
  QboSalesLine,
} from '../../src/qbo/entities.js'

export interface QboContractOptions {
  client: () => QboClient
  prefix: string // makes created names and DocNumbers unique to the run; keep it short
  settle: <T>(read: () => Promise<T>, ok: (v: T) => boolean) => Promise<T>
  cleanup?: boolean // delete invoices and deactivate customers created by the suite
}

const ITEM_SERVICES = '1'
const UNKNOWN_ID = '999999999'

interface LineSpec {
  amount: number
  itemId?: string
}

const invoiceBody = (customerId: string, lines: LineSpec[], extra: object = {}) => ({
  CustomerRef: { value: customerId },
  Line: lines.map((l) => ({
    Amount: l.amount,
    DetailType: 'SalesItemLineDetail',
    SalesItemLineDetail: { ItemRef: { value: l.itemId ?? ITEM_SERVICES } },
  })),
  ...extra,
})

const salesLines = (inv: QboInvoice): QboSalesLine[] =>
  inv.Line.filter((l): l is QboSalesLine => l.DetailType === 'SalesItemLineDetail')

const expectFault = (res: QboResponse, code: string): void => {
  expect(res.status).toBe(400)
  expect((res.body as QboFault).Fault.Error.map((e) => e.code)).toContain(code)
}

export function qboContract(opts: QboContractOptions): void {
  const { client, prefix, settle } = opts
  const created = { invoices: [] as string[], customers: [] as string[] }
  let seq = 0
  const unique = (label: string) => `${prefix}-${label}${++seq}`

  const entityOf = <T>(res: QboResponse, entity: QboEntityName): T => {
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    return (res.body as Record<string, T>)[entity]
  }

  const get = (entity: QboEntityName, id: string) =>
    client().request('GET', `/${entity.toLowerCase()}/${id}`)

  const update = (entity: QboEntityName, body: object) =>
    client().request('POST', `/${entity.toLowerCase()}`, { body: { ...body, sparse: true } })

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

  const queryInvoices = async (where: string): Promise<QboInvoice[]> => {
    const res = await client().query(`select * from Invoice where ${where}`)
    expect(res.status).toBe(200)
    return (res.body as { QueryResponse: { Invoice?: QboInvoice[] } }).QueryResponse.Invoice ?? []
  }

  afterAll(async () => {
    if (!opts.cleanup) return
    for (const id of created.invoices) {
      const invoice = entityOf<QboInvoice>(await get('Invoice', id), 'Invoice')
      await client().request('POST', '/invoice', {
        query: { operation: 'delete' },
        body: { Id: id, SyncToken: invoice.SyncToken },
      })
    }
    for (const id of created.customers) {
      const customer = entityOf<QboCustomer>(await get('Customer', id), 'Customer')
      await update('Customer', { Id: id, SyncToken: customer.SyncToken, Active: false })
    }
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
}
