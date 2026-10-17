// In-memory QBO Accounting API behind the QboClient transport interface.
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { QboClient, QboResponse, RequestOptions } from '../../src/qbo/client.js'
import type { QboEntityName } from '../../src/qbo/entities.js'
import { add, toMoney } from '../../src/money.js'

type Rec = Record<string, unknown> & { Id: string; SyncToken: string }
type Body = Record<string, unknown>
type Line = Record<string, unknown>
type Params = Record<string, string>

const ENTITIES: QboEntityName[] = ['Customer', 'Account', 'Item', 'Invoice', 'Payment']
const FIRST_ID = 1000
const FIRST_DOC_NUMBER = 1001
const COMPANY_OFFSET_HOURS = -7
const DEFAULT_TERMS_DAYS = 30
const QUERYABLE = ['Id', 'DocNumber', 'DisplayName', 'Name']
const READ_ONLY = [
  'Id',
  'SyncToken',
  'sparse',
  'domain',
  'MetaData',
  'TotalAmt',
  'Balance',
  'LinkedTxn',
]
const QUERY_RE = /^select \* from (\w+)(?: where (\w+) = '((?:[^'\\]|\\.)*)')?$/i

const entityName = (s: string): QboEntityName | undefined =>
  ENTITIES.find((e) => e.toLowerCase() === s.toLowerCase())

const ref = (value: string, name?: unknown) => ({ value, ...(name ? { name } : {}) })

// QBO renders timestamps in the company's time zone, at whole seconds
const qboTime = (d: Date): string => {
  const shifted = new Date(d.getTime() + COMPANY_OFFSET_HOURS * 3_600_000)
  const sign = COMPANY_OFFSET_HOURS < 0 ? '-' : '+'
  const hh = String(Math.abs(COMPANY_OFFSET_HOURS)).padStart(2, '0')
  return `${shifted.toISOString().slice(0, 19)}${sign}${hh}:00`
}

class Fault {
  constructor(
    readonly code: string,
    readonly message: string,
    readonly element = ''
  ) {}
}

export class FakeQbo implements QboClient {
  private readonly now: () => Date
  private readonly store = new Map<QboEntityName, Map<string, Rec>>(
    ENTITIES.map((e) => [e, new Map()])
  )
  private readonly nextId = new Map<QboEntityName, number>(ENTITIES.map((e) => [e, FIRST_ID]))
  private readonly lineSeq = new Map<string, number>() // highest line Id ever used, per invoice
  private nextDocNumber = FIRST_DOC_NUMBER

  constructor(opts: { now?: () => Date; realmId?: string } = {}) {
    this.now = opts.now ?? (() => new Date())
    this.save('Account', { Id: '1', Name: 'Services', AccountType: 'Income' })
    this.save('Account', { Id: '4', Name: 'Undeposited Funds', AccountType: 'Other Current Asset' })
    this.save('Account', {
      Id: '84',
      Name: 'Accounts Receivable (A/R)',
      AccountType: 'Accounts Receivable',
    })
    this.save('Item', {
      Id: '1',
      Name: 'Services',
      Type: 'Service',
      IncomeAccountRef: ref('1', 'Services'),
    })
  }

  async request(method: string, path: string, opts: RequestOptions = {}): Promise<QboResponse> {
    const url = new URL(path, 'http://fake')
    const params: Params = { ...Object.fromEntries(url.searchParams), ...opts.query }
    const [first, id, ...rest] = url.pathname.split('/').filter(Boolean)
    const entity = entityName(first ?? '')
    try {
      if (method === 'GET' && first === 'query' && !id) return this.runQuery(params.query ?? '')
      if (entity && rest.length === 0 && Object.keys(params).length === 0) {
        if (method === 'GET' && id) return this.read(entity, id)
        if (method === 'POST' && !id) return this.write(entity, (opts.body ?? {}) as Body)
      }
    } catch (e) {
      if (e instanceof Fault) return this.fault(e)
      throw e
    }
    throw new Error(`FakeQbo: unsupported ${method} ${path}`)
  }

  query(sql: string): Promise<QboResponse> {
    return this.request('GET', '/query', { query: { query: sql } })
  }

  private read(entity: QboEntityName, id: string): QboResponse {
    return this.ok({ [entity]: this.view(entity, this.find(entity, id)) })
  }

  private write(entity: QboEntityName, body: Body): QboResponse {
    if (body.Id === undefined) return this.create(entity, body)
    if (body.sparse !== true) throw new Error('FakeQbo: only sparse updates are supported')
    return this.sparseUpdate(entity, body)
  }

  private create(entity: QboEntityName, body: Body): QboResponse {
    const build = this.creators[entity]
    if (!build) throw new Error(`FakeQbo: unsupported create of ${entity}`)
    const id = String(this.nextId.get(entity))
    const fields = build(id, body)
    this.nextId.set(entity, Number(id) + 1)
    return this.ok({ [entity]: this.view(entity, this.save(entity, { Id: id, ...fields })) })
  }

  private readonly creators: Partial<Record<QboEntityName, (id: string, body: Body) => Body>> = {
    Customer: (_id, body) => {
      const DisplayName = String(body.DisplayName)
      this.assertUniqueName('Customer', 'DisplayName', DisplayName)
      return { DisplayName, Active: true }
    },
    Invoice: (id, body) => {
      const today = qboTime(this.now()).slice(0, 10)
      const due = new Date(`${today}T00:00:00Z`)
      due.setUTCDate(due.getUTCDate() + DEFAULT_TERMS_DAYS)
      return {
        DocNumber: body.DocNumber || String(this.nextDocNumber++),
        TxnDate: today,
        DueDate: due.toISOString().slice(0, 10),
        CurrencyRef: ref('USD', 'United States Dollar'),
        ...this.writable(body),
        CustomerRef: this.customerRef(body.CustomerRef),
        Line: this.lines(id, [], body.Line),
      }
    },
  }

  private sparseUpdate(entity: QboEntityName, body: Body): QboResponse {
    const current = this.find(entity, String(body.Id))
    if (String(body.SyncToken) !== current.SyncToken) {
      throw new Fault('5010', 'Stale Object Error')
    }
    const next: Rec = { ...current }
    for (const [key, value] of Object.entries(this.writable(body))) {
      if (value === '') delete next[key]
      else next[key] = value
    }
    if (entity === 'Customer' && next.DisplayName !== current.DisplayName) {
      this.assertUniqueName('Customer', 'DisplayName', String(next.DisplayName), current.Id)
    }
    if (entity === 'Invoice') {
      next.CustomerRef = this.customerRef(next.CustomerRef)
      if (body.Line !== undefined) next.Line = this.lines(current.Id, current.Line, body.Line)
    }
    const changed = !isDeepStrictEqual(next, current)
    return this.ok({ [entity]: this.view(entity, changed ? this.save(entity, next) : current) })
  }

  // Stores a record, bumping SyncToken and LastUpdatedTime when it already exists.
  private save(entity: QboEntityName, rec: Body & { Id: string }): Rec {
    const now = qboTime(this.now())
    const prev = this.store.get(entity)!.get(rec.Id)
    const SyncToken = prev ? String(Number(prev.SyncToken) + 1) : '0'
    const CreateTime = prev ? (prev.MetaData as { CreateTime: string }).CreateTime : now
    const saved: Rec = {
      ...rec,
      SyncToken,
      domain: 'QBO',
      sparse: false,
      MetaData: { CreateTime, LastUpdatedTime: now },
    }
    this.store.get(entity)!.set(rec.Id, saved)
    return saved
  }

  private find(entity: QboEntityName, id: string): Rec {
    const rec = this.store.get(entity)!.get(id)
    if (!rec) throw new Fault('610', 'Object Not Found')
    return rec
  }

  // The fields of a write body that the client may set; null is ignored, as is DocNumber "".
  private writable(body: Body): Body {
    return Object.fromEntries(
      Object.entries(body).filter(
        ([k, v]) =>
          !READ_ONLY.includes(k) && v !== null && !(k === 'DocNumber' && v === '') && k !== 'Line'
      )
    )
  }

  private assertUniqueName(entity: QboEntityName, field: string, name: string, selfId?: string) {
    const taken = [...this.store.get(entity)!.values()].some(
      (r) => r.Id !== selfId && String(r[field]).toLowerCase() === name.toLowerCase()
    )
    if (taken) throw new Fault('6240', 'Duplicate Name Exists Error', field)
  }

  private customerRef(value: unknown) {
    const id = (value as { value?: string } | undefined)?.value ?? ''
    const customer = this.store.get('Customer')!.get(id)
    if (!customer) throw new Fault('2500', 'Invalid Reference Id', 'CustomerRef')
    return ref(id, customer.DisplayName)
  }

  // Sales lines after a write: known Ids are kept, others get a new, never reused Id.
  private lines(invoiceId: string, current: unknown, sent: unknown): Line[] {
    const known = new Set((current as Line[]).map((l) => l.Id))
    if (!Array.isArray(sent) || sent.length === 0) {
      throw new Fault('2020', 'Required param missing', 'Line')
    }
    let seq = this.lineSeq.get(invoiceId) ?? 0
    const lines = (sent as Line[])
      .filter((l) => l.DetailType === 'SalesItemLineDetail')
      .map((l, i) => {
        const detail = l.SalesItemLineDetail as { ItemRef?: { value: string } }
        const itemId = detail.ItemRef?.value ?? '1'
        const item = this.store.get('Item')!.get(itemId)
        if (!item) throw new Fault('2500', 'Invalid Reference Id', 'ItemRef')
        return {
          ...l,
          Id: known.has(l.Id) ? l.Id : String(++seq),
          LineNum: i + 1,
          Amount: Number(toMoney(l.Amount as number)),
          SalesItemLineDetail: {
            TaxCodeRef: ref('NON'),
            ...detail,
            ItemRef: ref(itemId, item.Name),
            ItemAccountRef: item.IncomeAccountRef,
          },
        }
      })
    this.lineSeq.set(invoiceId, seq)
    return lines
  }

  // A record as QBO returns it, with its computed fields.
  private view(entity: QboEntityName, rec: Rec): Body {
    if (entity !== 'Invoice') return structuredClone(rec)
    const lines = rec.Line as Line[]
    const total = Number(add(...lines.map((l) => toMoney(l.Amount as number))))
    return structuredClone({
      ...rec,
      Line: [...lines, { Amount: total, DetailType: 'SubTotalLineDetail', SubTotalLineDetail: {} }],
      TxnTaxDetail: { TotalTax: 0 },
      TotalAmt: total,
      Balance: total,
      LinkedTxn: [],
    })
  }

  private runQuery(sql: string): QboResponse {
    const m = QUERY_RE.exec(sql.trim())
    const entity = entityName(m?.[1] ?? '')
    const field = QUERYABLE.find((f) => f.toLowerCase() === m?.[2]?.toLowerCase())
    if (!m || !entity || (m[2] && !field)) throw new Error(`FakeQbo: unsupported query ${sql}`)
    const value = m[3]?.replace(/\\(.)/g, '$1').toLowerCase()
    const rows = [...this.store.get(entity)!.values()]
      .filter((r) => r.Active !== false)
      .filter((r) => !field || String(r[field] ?? '').toLowerCase() === value)
      .map((r) => this.view(entity, r))
    const page = rows.length ? { [entity]: rows, startPosition: 1, maxResults: rows.length } : {}
    return this.ok({ QueryResponse: page })
  }

  private ok(body: Body): QboResponse {
    return this.respond(200, body)
  }

  private fault(f: Fault): QboResponse {
    const error = { Message: f.message, Detail: f.message, code: f.code, element: f.element }
    return this.respond(400, { Fault: { Error: [error], type: 'ValidationFault' } })
  }

  private respond(status: number, body: Body): QboResponse {
    const intuitTid = randomUUID()
    return {
      status,
      intuitTid,
      headers: { intuit_tid: intuitTid },
      body: { ...body, time: this.now().toISOString() },
    }
  }
}
