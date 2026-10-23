// Typed QBO entity operations over the transport client; failures surface as QboApiError.
import type { QboClient, QboResponse } from './client.js'
import type {
  QboAccount,
  QboCustomer,
  QboDeletedStub,
  QboEntityName,
  QboInvoice,
  QboItem,
  QboPayment,
} from './entities.js'
import { checkTextLimits } from './limits.js'

export interface QboEntities {
  Account: QboAccount
  Item: QboItem
  Customer: QboCustomer
  Invoice: QboInvoice
  Payment: QboPayment
}

export interface QboChange {
  entity: QboEntityName
  id: string
  deleted: boolean
  updated: string | null
}

// An entity whose changes filled a whole CDC response: more may be waiting behind it.
export interface QboCappedEntity {
  entity: QboEntityName
  lastUpdated: string | null // the latest update time among the rows that did come back
}

export interface QboChangeSet {
  changes: QboChange[]
  capped: QboCappedEntity[]
}

export const CDC_MAX_PER_ENTITY = 1000
const QUERY_PAGE_SIZE = 1000

interface FaultError {
  code?: string
  Message?: string
  message?: string
}

const NOT_FOUND = '610'

// Both envelopes: `Fault.Error` from the API, `fault.error` from Intuit's gateway.
function faultErrors(body: unknown): FaultError[] | null {
  if (typeof body !== 'object' || body === null) {
    return null
  }
  const b = body as { Fault?: { Error?: FaultError[] }; fault?: { error?: FaultError[] } }
  if (b.Fault) {
    return b.Fault.Error ?? []
  }
  if (b.fault) {
    return b.fault.error ?? []
  }
  return null
}

export class QboApiError extends Error {
  constructor(
    readonly status: number,
    readonly codes: string[],
    readonly retryAfterMs: number | null,
    readonly intuitTid: string | null,
    message: string
  ) {
    super(message)
    this.name = 'QboApiError'
  }

  static from(res: QboResponse): QboApiError | null {
    const errors = faultErrors(res.body)
    if (res.status < 300 && !errors) {
      return null
    }
    const codes = (errors ?? []).flatMap((e) => (e.code ? [e.code] : []))
    const seconds = Number(res.headers['retry-after'])
    const retryAfterMs =
      Number.isFinite(seconds) && res.headers['retry-after'] ? seconds * 1000 : null
    const text = (errors ?? [])
      .map((e) => e.Message ?? e.message)
      .filter(Boolean)
      .join('; ')
    return new QboApiError(
      res.status,
      codes,
      retryAfterMs,
      res.intuitTid,
      `QBO ${res.status}${codes.length ? ` [${codes.join(',')}]` : ''}${text ? `: ${text}` : ''}`
    )
  }
}

type CdcRow = QboInvoice | QboDeletedStub

const changeOf = (entity: QboEntityName, row: CdcRow): QboChange => ({
  entity,
  id: row.Id,
  deleted: 'status' in row && row.status === 'Deleted',
  updated: row.MetaData?.LastUpdatedTime ?? null,
})

function latestUpdate(rows: CdcRow[]): string | null {
  const times = rows.flatMap((row) => {
    const updated = row.MetaData?.LastUpdatedTime
    return updated ? [new Date(updated).getTime()] : []
  })
  return times.length > 0 ? new Date(Math.max(...times)).toISOString() : null
}

const path = (entity: QboEntityName) => `/${entity.toLowerCase()}`
const quote = (s: string) => `'${s.replace(/[\\']/g, '\\$&')}'`

export class QboApi {
  constructor(private readonly client: QboClient) {}

  async get<E extends keyof QboEntities>(entity: E, id: string): Promise<QboEntities[E] | null> {
    const res = await this.client.request('GET', `${path(entity)}/${id}`)
    const error = QboApiError.from(res)
    if (error?.codes.includes(NOT_FOUND)) {
      return null
    }
    return this.entityOf(res, entity)
  }

  async create<E extends keyof QboEntities>(
    entity: E,
    body: Record<string, unknown>,
    requestId: string
  ): Promise<QboEntities[E]> {
    checkTextLimits(body)
    const res = await this.client.request('POST', path(entity), { body, requestId })
    return this.entityOf(res, entity)
  }

  async update<E extends keyof QboEntities>(
    entity: E,
    body: { Id: string; SyncToken: string } & Record<string, unknown>
  ): Promise<QboEntities[E]> {
    checkTextLimits(body)
    const res = await this.client.request('POST', path(entity), {
      body: { ...body, sparse: true },
    })
    return this.entityOf(res, entity)
  }

  async voidInvoice(id: string, syncToken: string): Promise<QboInvoice> {
    const res = await this.client.request('POST', path('Invoice'), {
      body: { Id: id, SyncToken: syncToken },
      query: { operation: 'void' },
    })
    return this.entityOf(res, 'Invoice')
  }

  async remove(entity: 'Invoice' | 'Payment', id: string, syncToken: string): Promise<void> {
    const res = await this.client.request('POST', path(entity), {
      body: { Id: id, SyncToken: syncToken },
      query: { operation: 'delete' },
    })
    this.entityOf<QboDeletedStub>(res, entity)
  }

  findByName<E extends 'Account' | 'Item' | 'Customer'>(
    entity: E,
    name: string
  ): Promise<QboEntities[E][]> {
    const field = entity === 'Customer' ? 'DisplayName' : 'Name'
    return this.select(entity, `${field} = ${quote(name)}`)
  }

  findInvoicesByNumber(docNumber: string): Promise<QboInvoice[]> {
    return this.select('Invoice', `DocNumber = ${quote(docNumber)}`)
  }

  findPaymentsByCustomer(customerId: string): Promise<QboPayment[]> {
    return this.select('Payment', `CustomerRef = ${quote(customerId)}`)
  }

  async listAll<E extends keyof QboEntities>(entity: E): Promise<QboEntities[E][]> {
    const all: QboEntities[E][] = []
    for (;;) {
      const page = await this.select(
        entity,
        undefined,
        ` startposition ${all.length + 1} maxresults ${QUERY_PAGE_SIZE}`
      )
      all.push(...page)
      if (page.length < QUERY_PAGE_SIZE) {
        return all
      }
    }
  }

  async changes(entities: readonly QboEntityName[], since: string): Promise<QboChangeSet> {
    const res = await this.client.request('GET', '/cdc', {
      query: { entities: entities.join(','), changedSince: since },
    })
    const error = QboApiError.from(res)
    if (error) {
      throw error
    }
    const { CDCResponse } = res.body as {
      CDCResponse: { QueryResponse: Record<string, unknown>[] }[]
    }
    const changes: QboChange[] = []
    const capped: QboCappedEntity[] = []
    for (const group of CDCResponse.flatMap((r) => r.QueryResponse)) {
      for (const entity of entities) {
        const rows = (group[entity] ?? []) as CdcRow[]
        changes.push(...rows.map((row) => changeOf(entity, row)))
        if (rows.length >= CDC_MAX_PER_ENTITY) {
          capped.push({ entity, lastUpdated: latestUpdate(rows) })
        }
      }
    }
    return { changes, capped }
  }

  private async select<E extends keyof QboEntities>(
    entity: E,
    where?: string,
    paging = ''
  ): Promise<QboEntities[E][]> {
    const res = await this.client.query(
      `select * from ${entity}${where ? ` where ${where}` : ''}${paging}`
    )
    const error = QboApiError.from(res)
    if (error) {
      throw error
    }
    const { QueryResponse } = res.body as { QueryResponse: Record<string, QboEntities[E][]> }
    return QueryResponse[entity] ?? []
  }

  private entityOf<T>(res: QboResponse, entity: QboEntityName): T {
    const error = QboApiError.from(res)
    if (error) {
      throw error
    }
    const found = (res.body as Record<string, T | undefined> | null)?.[entity]
    if (found === undefined || found === null) {
      throw new QboApiError(
        res.status,
        [],
        null,
        res.intuitTid,
        `QBO ${res.status} without ${entity}`
      )
    }
    return found
  }
}
