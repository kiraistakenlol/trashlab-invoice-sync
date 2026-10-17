// Test-side QBO edits made through the API only, as a person or another system would.
import { randomUUID } from 'node:crypto'
import { QboApi, type QboEntities } from '../../src/qbo/api.js'
import type { QboClient } from '../../src/qbo/client.js'
import type { QboCustomer, QboInvoice, QboItem, QboPayment } from '../../src/qbo/entities.js'

export interface LineSpec {
  amount: number
  itemId?: string
  taxCode?: 'TAX' | 'NON'
}

export interface Application {
  invoiceId: string
  amount: number
}

const SERVICES_ITEM = '1'
const SERVICES_ACCOUNT = '1'

export class QboActor {
  private readonly api: QboApi

  constructor(private readonly client: QboClient) {
    this.api = new QboApi(client)
  }

  get<E extends keyof QboEntities>(entity: E, id: string): Promise<QboEntities[E] | null> {
    return this.api.get(entity, id)
  }

  createCustomer(name: string): Promise<QboCustomer> {
    return this.api.create('Customer', { DisplayName: name }, randomUUID())
  }

  createItem(name: string, incomeAccountId = SERVICES_ACCOUNT): Promise<QboItem> {
    return this.api.create(
      'Item',
      { Name: name, Type: 'Service', IncomeAccountRef: { value: incomeAccountId } },
      randomUUID()
    )
  }

  createInvoice(
    customerId: string,
    lines: LineSpec[],
    extra: Record<string, unknown> = {}
  ): Promise<QboInvoice> {
    return this.api.create(
      'Invoice',
      {
        CustomerRef: { value: customerId },
        Line: lines.map((l) => ({
          Amount: l.amount,
          DetailType: 'SalesItemLineDetail',
          SalesItemLineDetail: {
            ItemRef: { value: l.itemId ?? SERVICES_ITEM },
            ...(l.taxCode ? { TaxCodeRef: { value: l.taxCode } } : {}),
          },
        })),
        ...extra,
      },
      randomUUID()
    )
  }

  async updateInvoice(id: string, patch: Record<string, unknown>): Promise<QboInvoice> {
    const current = await this.current('Invoice', id)
    return this.api.update('Invoice', { ...patch, Id: id, SyncToken: current.SyncToken })
  }

  async voidInvoice(id: string): Promise<QboInvoice> {
    const current = await this.current('Invoice', id)
    return this.api.voidInvoice(id, current.SyncToken)
  }

  async deleteInvoice(id: string): Promise<void> {
    const current = await this.current('Invoice', id)
    await this.api.remove('Invoice', id, current.SyncToken)
  }

  createPayment(
    customerId: string,
    total: number,
    applications: Application[]
  ): Promise<QboPayment> {
    return this.api.create(
      'Payment',
      {
        CustomerRef: { value: customerId },
        TotalAmt: total,
        Line: applications.map((a) => ({
          Amount: a.amount,
          LinkedTxn: [{ TxnId: a.invoiceId, TxnType: 'Invoice' }],
        })),
      },
      randomUUID()
    )
  }

  async deletePayment(id: string): Promise<void> {
    const current = await this.current('Payment', id)
    await this.api.remove('Payment', id, current.SyncToken)
  }

  async voidPayment(id: string): Promise<void> {
    const current = await this.current('Payment', id)
    const res = await this.client.request('POST', '/payment', {
      body: { Id: id, SyncToken: current.SyncToken, sparse: true },
      query: { operation: 'update', include: 'void' },
    })
    if (res.status !== 200) throw new Error(`void payment ${id}: ${JSON.stringify(res.body)}`)
  }

  private async current<E extends keyof QboEntities>(entity: E, id: string) {
    const found = await this.api.get(entity, id)
    if (!found) throw new Error(`${entity} ${id} not found`)
    return found
  }
}
