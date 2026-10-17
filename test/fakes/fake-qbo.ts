// In-memory QBO Accounting API behind the QboClient transport interface.
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { QboClient, QboResponse, RequestOptions } from '../../src/qbo/client.js'
import type { QboEntityName, QboRef } from '../../src/qbo/entities.js'
import type { QboWebhookEntity } from '../../src/qbo/webhooks.js'
import { add, percentOf, toMoney } from '../../src/money.js'
import { timeoutError, type Failure } from './failures.js'
import { QboChanges, type Operation } from './fake-qbo-changes.js'
import { PaymentLedger } from './fake-qbo-payments.js'
import {
  ENTITIES,
  Fault,
  QboRecords,
  qboTime,
  ref,
  type Body,
  type Rec,
} from './fake-qbo-records.js'

type Line = Record<string, unknown>
type Params = Record<string, string>
export type QboFailure = Failure | 'http_429' | 'http_500' | 'http_401' | 'http_425'
interface FailureMatch {
  method?: string
  path?: string // prefix of the request path, without its query string
}

const FIRST_ID = 1000
const FIRST_DOC_NUMBER = 1001
const DEFAULT_TERMS_DAYS = 30
const MAX_REQUEST_ID = 50
const QUERYABLE = ['Id', 'DocNumber', 'DisplayName', 'Name']
const WRITE_PARAMS = ['requestid', 'operation', 'include']
const READ_ONLY = [
  'Id',
  'SyncToken',
  'sparse',
  'domain',
  'MetaData',
  'TotalAmt',
  'Balance',
  'LinkedTxn',
  'UnappliedAmt',
]
const SALES_TAX_CODE = '2'
const SALES_TAX_RATE = '0.08'
const TAX_ERROR =
  'QuickBooks encountered an error while calculating tax. Try reselecting the tax rate or ' +
  'reentering the product/service item and saving the form again.'
const RULED = ['Line', 'TxnTaxDetail'] // set by their own rules, not copied from the body
const QUERY_RE = /^select \* from (\w+)(?: where (\w+) = '((?:[^'\\]|\\.)*)')?$/i

const entityName = (s: string): QboEntityName | undefined =>
  ENTITIES.find((e) => e.toLowerCase() === s.toLowerCase())

export class FakeQbo implements QboClient {
  private readonly now: () => Date
  private readonly records: QboRecords
  private readonly ledger: PaymentLedger
  private readonly changes = new QboChanges()
  private readonly nextId = new Map<QboEntityName, number>(ENTITIES.map((e) => [e, FIRST_ID]))
  private readonly lineSeq = new Map<string, number>() // highest line Id ever used, per invoice
  private nextDocNumber = FIRST_DOC_NUMBER
  private readonly replays = new Map<string, { entity: QboEntityName; response: QboResponse }>()
  private readonly failures: { match: FailureMatch; failure: QboFailure }[] = []

  constructor(opts: { now?: () => Date; realmId?: string } = {}) {
    this.now = opts.now ?? (() => new Date())
    this.records = new QboRecords(this.now)
    this.ledger = new PaymentLedger(this.records)
    this.records.save('Account', { Id: '1', Name: 'Services', AccountType: 'Income' })
    this.records.save('Account', {
      Id: '4',
      Name: 'Undeposited Funds',
      AccountType: 'Other Current Asset',
    })
    this.records.save('Account', {
      Id: '84',
      Name: 'Accounts Receivable (A/R)',
      AccountType: 'Accounts Receivable',
    })
    this.records.save('Item', {
      Id: '1',
      Name: 'Services',
      Type: 'Service',
      IncomeAccountRef: ref('1', 'Services'),
    })
  }

  async request(method: string, path: string, opts: RequestOptions = {}): Promise<QboResponse> {
    const url = new URL(path, 'http://fake')
    const failure = this.takeFailure(method, url.pathname)
    if (failure === 'timeout_before_write') throw timeoutError()
    if (failure && failure !== 'timeout_after_write') return this.failed(failure)
    const response = this.route(method, url, opts)
    if (failure === 'timeout_after_write') throw timeoutError()
    return response
  }

  query(sql: string): Promise<QboResponse> {
    return this.request('GET', '/query', { query: { query: sql } })
  }

  // Arms the next matching request to fail once; arming twice queues both
  failNext(match: FailureMatch, failure: QboFailure): void {
    this.failures.push({ match, failure })
  }

  takeWebhooks(opts?: Parameters<QboChanges['takeWebhooks']>[0]): QboWebhookEntity[] {
    return this.changes.takeWebhooks(opts)
  }

  // What saving an invoice in the QBO web UI does: it taxes all lines at the company rate
  // while they stay NON.
  uiSaveInvoice(id: string): void {
    const current = this.records.find('Invoice', id)
    const TxnTaxDetail = this.taxOn(current.Line as Line[])
    this.logChange('Invoice', 'Update', this.records.save('Invoice', { ...current, TxnTaxDetail }))
  }

  private route(method: string, url: URL, opts: RequestOptions): QboResponse {
    const params: Params = {
      ...Object.fromEntries(url.searchParams),
      ...opts.query,
      ...(opts.requestId ? { requestid: opts.requestId } : {}),
    }
    const [first, id, ...rest] = url.pathname.split('/').filter(Boolean)
    const entity = entityName(first ?? '')
    const body = (opts.body ?? {}) as Body
    try {
      if (method === 'GET' && first === 'query' && !id) return this.runQuery(params.query ?? '')
      if (method === 'GET' && first === 'cdc' && !id) return this.cdc(params)
      if (entity && rest.length === 0) {
        if (method === 'GET' && id && Object.keys(params).length === 0) {
          return this.ok({ [entity]: this.view(entity, this.records.find(entity, id)) })
        }
        const operation = method === 'POST' && !id && this.operation(entity, params, body)
        if (operation) {
          return this.once(entity, params.requestid, () => {
            const written = this.write(entity, operation, body)
            // an update that changed nothing keeps its SyncToken
            const changed = operation !== 'Update' || written.SyncToken !== String(body.SyncToken)
            if (changed) this.logChange(entity, operation, written)
            return written
          })
        }
      }
    } catch (e) {
      if (e instanceof Fault) return this.fault(e)
      throw e
    }
    throw new Error(`FakeQbo: unsupported ${method} ${url.pathname}${url.search}`)
  }

  private takeFailure(method: string, path: string): QboFailure | undefined {
    const i = this.failures.findIndex(
      ({ match }) =>
        (match.method === undefined || match.method === method) &&
        (match.path === undefined || path.startsWith(match.path))
    )
    return i < 0 ? undefined : this.failures.splice(i, 1)[0].failure
  }

  // The write a POST asks for; undefined when the fake does not support it.
  private operation(entity: QboEntityName, params: Params, body: Body): Operation | undefined {
    if (Object.keys(params).some((k) => !WRITE_PARAMS.includes(k))) return undefined
    const { operation, include } = params
    const transaction = entity === 'Invoice' || entity === 'Payment'
    if (!operation && !include) return body.Id === undefined ? 'Create' : 'Update'
    if (entity === 'Payment' && operation === 'update' && include === 'void') return 'Void'
    if (include) return undefined
    if (entity === 'Invoice' && operation === 'void') return 'Void'
    if (transaction && operation === 'delete') return 'Delete'
    return undefined
  }

  // Runs a write at most once per requestid; a later request with the key, whatever its body
  // or target, gets the stored response.
  private once(entity: QboEntityName, key: string | undefined, run: () => Body): QboResponse {
    if (key === undefined) return this.ok({ [entity]: run() })
    if (key.length > MAX_REQUEST_ID) {
      throw new Fault('6000', 'You cannot enter more than 50 characters in the request_id field')
    }
    const stored = this.replays.get(key)
    if (stored && stored.entity !== entity) throw new Fault('6000', 'An unexpected error occurred')
    if (stored) return structuredClone(stored.response)
    const response = this.ok({ [entity]: run() })
    this.replays.set(key, { entity, response: structuredClone(response) })
    return response
  }

  private logChange(entity: QboEntityName, operation: Operation, written: Body): void {
    const meta = written.MetaData as { LastUpdatedTime: string } | undefined
    const time = operation === 'Delete' || !meta ? this.now() : new Date(meta.LastUpdatedTime)
    this.changes.record({ entity, id: String(written.Id), operation, time })
  }

  // Applies one write and returns the entity body of its response.
  private write(entity: QboEntityName, operation: Operation, body: Body): Body {
    switch (operation) {
      case 'Create':
        return this.create(entity, body)
      case 'Update':
        if (body.sparse !== true) throw new Error('FakeQbo: only sparse updates are supported')
        return this.sparseUpdate(entity, body)
      case 'Void':
        return entity === 'Invoice' ? this.voidInvoice(body) : this.voidPayment(body)
      case 'Delete':
        return this.remove(entity, body)
    }
  }

  private create(entity: QboEntityName, body: Body): Body {
    const build = this.creators[entity]
    if (!build) throw new Error(`FakeQbo: unsupported create of ${entity}`)
    const id = String(this.nextId.get(entity))
    const fields = build(id, body)
    this.nextId.set(entity, Number(id) + 1)
    const saved = this.records.save(entity, { Id: id, ...fields })
    if (entity === 'Payment') this.ledger.bumpInvoices([], saved.Line)
    return this.view(entity, saved)
  }

  private readonly creators: Partial<Record<QboEntityName, (id: string, body: Body) => Body>> = {
    Customer: (_id, body) => {
      const DisplayName = String(body.DisplayName)
      this.assertUniqueName('Customer', 'DisplayName', DisplayName)
      return { DisplayName, Active: true }
    },
    Invoice: (id, body) => {
      const due = new Date(`${this.today()}T00:00:00Z`)
      due.setUTCDate(due.getUTCDate() + DEFAULT_TERMS_DAYS)
      return {
        DocNumber: body.DocNumber || String(this.nextDocNumber++),
        TxnDate: this.today(),
        DueDate: due.toISOString().slice(0, 10),
        CurrencyRef: ref('USD', 'United States Dollar'),
        ...this.writable(body),
        CustomerRef: this.records.customerRef(body.CustomerRef),
        ...this.taxedLines(id, [], body, false),
      }
    },
    Payment: (id, body) => ({
      TxnDate: this.today(),
      DepositToAccountRef: ref('4', 'Undeposited Funds'),
      ...this.writable(body),
      ...this.ledger.payment(id, body),
    }),
  }

  private sparseUpdate(entity: QboEntityName, body: Body): Body {
    if (entity === 'Payment' && body.CustomerRef === undefined) {
      throw new Fault('2020', 'Required param missing', 'CustomerRef')
    }
    const current = this.current(entity, body)
    const next: Rec = { ...current }
    for (const [key, value] of Object.entries(this.writable(body))) {
      if (value === '') delete next[key]
      else next[key] = value
    }
    if (entity === 'Customer' && next.DisplayName !== current.DisplayName) {
      this.assertUniqueName('Customer', 'DisplayName', String(next.DisplayName), current.Id)
    }
    if (entity === 'Invoice') {
      next.CustomerRef = this.records.customerRef(next.CustomerRef)
      if (body.Line !== undefined) {
        delete next.TxnTaxDetail
        const taxed = current.TxnTaxDetail !== undefined
        Object.assign(next, this.taxedLines(current.Id, current.Line, body, taxed))
      }
    }
    if (entity === 'Payment')
      Object.assign(next, this.ledger.payment(current.Id, { ...current, ...body }))
    // a ref's name follows renames of the customer; only its value identifies the customer
    const refValue = (r: unknown) => (r as { value?: string } | undefined)?.value
    const sameCustomer = refValue(next.CustomerRef) === refValue(current.CustomerRef)
    if (sameCustomer && current.CustomerRef) next.CustomerRef = current.CustomerRef
    if (isDeepStrictEqual(next, current)) return this.view(entity, current)
    const saved = this.records.save(entity, next)
    if (entity === 'Invoice')
      this.ledger.refit(saved.Id, sameCustomer ? this.ledger.total(saved) : undefined)
    if (entity === 'Payment') this.ledger.bumpInvoices(current.Line, saved.Line)
    return this.view(entity, saved)
  }

  private voidInvoice(body: Body): Body {
    if (body.SyncToken === undefined) {
      throw new Fault('6000', "You can't void this transaction because it has never been saved")
    }
    const current = this.current('Invoice', body)
    const Line = (current.Line as Line[]).map((l) => {
      const detail = { ...(l.SalesItemLineDetail as Body) }
      delete detail.Qty
      delete detail.UnitPrice
      return { ...l, Amount: 0, SalesItemLineDetail: detail }
    })
    const note = current.PrivateNote
    const PrivateNote = note === undefined ? 'Voided' : `Voided - ${note}`
    const tax = current.TxnTaxDetail as Body | undefined
    const TxnTaxDetail = tax ? { TxnTaxDetail: { ...tax, TotalTax: 0 } } : {}
    const saved = this.records.save('Invoice', { ...current, Line, PrivateNote, ...TxnTaxDetail })
    this.ledger.refit(saved.Id)
    return this.view('Invoice', saved)
  }

  private voidPayment(body: Body): Body {
    const current = this.current('Payment', body)
    const saved = this.records.save('Payment', {
      ...current,
      TotalAmt: 0,
      Line: [],
      PrivateNote: 'Voided',
    })
    this.ledger.bumpInvoices(current.Line, [])
    return this.view('Payment', saved)
  }

  // Delete checks that a SyncToken is sent, not that it is current.
  private remove(entity: QboEntityName, body: Body): Body {
    if (body.SyncToken === undefined) throw new Fault('2020', 'Required param missing', 'SyncToken')
    const current = this.records.find(entity, String(body.Id))
    if (entity === 'Invoice') this.ledger.refit(current.Id)
    if (entity === 'Payment') this.ledger.bumpInvoices(current.Line, [])
    this.records.delete(entity, current.Id)
    return { domain: 'QBO', status: 'Deleted', Id: current.Id }
  }

  // The record a write targets, provided the write carries its current SyncToken.
  private current(entity: QboEntityName, body: Body): Rec {
    const rec = this.records.find(entity, String(body.Id))
    if (String(body.SyncToken) !== rec.SyncToken) throw new Fault('5010', 'Stale Object Error')
    return rec
  }

  // The plain fields of a write body that the client may set; null is ignored, as is
  // DocNumber "".
  private writable(body: Body): Body {
    return Object.fromEntries(
      Object.entries(body).filter(
        ([k, v]) =>
          !READ_ONLY.includes(k) &&
          !RULED.includes(k) &&
          v !== null &&
          !(k === 'DocNumber' && v === '')
      )
    )
  }

  // An invoice's lines after a write, with its sales tax: taxed only when lines are TAX and the
  // body sends the tax code, which a taxed invoice requires with every line change.
  private taxedLines(invoiceId: string, current: unknown, body: Body, taxed: boolean): Body {
    const Line = this.lines(invoiceId, current, body.Line)
    const code = ((body.TxnTaxDetail as Body | undefined)?.TxnTaxCodeRef as QboRef | undefined)
      ?.value
    if (code === undefined) {
      if (taxed) throw new Fault('6000', TAX_ERROR)
      return { Line }
    }
    if (code !== SALES_TAX_CODE) throw new Error(`FakeQbo: unsupported tax code ${code}`)
    const taxable = Line.filter(
      (l) => (l.SalesItemLineDetail as { TaxCodeRef: QboRef }).TaxCodeRef.value === 'TAX'
    )
    return taxable.length ? { Line, TxnTaxDetail: this.taxOn(taxable) } : { Line }
  }

  private taxOn(lines: Line[]): Body {
    const net = add(...lines.map((l) => toMoney(l.Amount as number)))
    const TotalTax = Number(percentOf(net, SALES_TAX_RATE))
    return { TxnTaxCodeRef: ref(SALES_TAX_CODE), TotalTax }
  }

  private assertUniqueName(entity: QboEntityName, field: string, name: string, selfId?: string) {
    const taken = this.records
      .all(entity)
      .some((r) => r.Id !== selfId && String(r[field]).toLowerCase() === name.toLowerCase())
    if (taken) throw new Fault('6240', 'Duplicate Name Exists Error', field)
  }

  private today(): string {
    return qboTime(this.now()).slice(0, 10)
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
        const detail = l.SalesItemLineDetail as Body | undefined
        if (!detail || Object.keys(detail).length === 0) {
          throw new Fault('2020', 'Required param missing', 'SalesItemLineDetail')
        }
        const itemId = (detail.ItemRef as { value?: string } | undefined)?.value ?? '1'
        const item = this.records.get('Item', itemId)
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
    if (entity === 'Payment') {
      return structuredClone({ ...rec, UnappliedAmt: Number(this.ledger.unapplied(rec)) })
    }
    if (entity !== 'Invoice') return structuredClone(rec)
    const subtotal = this.ledger.subtotal(rec)
    return structuredClone({
      ...rec,
      Line: [
        ...(rec.Line as Line[]),
        { Amount: Number(subtotal), DetailType: 'SubTotalLineDetail', SubTotalLineDetail: {} },
      ],
      TxnTaxDetail: rec.TxnTaxDetail ?? { TotalTax: 0 },
      TotalAmt: Number(this.ledger.total(rec)),
      Balance: Number(this.ledger.balance(rec)),
      LinkedTxn: this.ledger.applications(rec.Id).map((a) => ({
        TxnId: a.payment.Id,
        TxnType: 'Payment',
      })),
    })
  }

  private runQuery(sql: string): QboResponse {
    const m = QUERY_RE.exec(sql.trim())
    const entity = entityName(m?.[1] ?? '')
    const field = QUERYABLE.find((f) => f.toLowerCase() === m?.[2]?.toLowerCase())
    if (!m || !entity || (m[2] && !field)) throw new Error(`FakeQbo: unsupported query ${sql}`)
    const value = m[3]?.replace(/\\(.)/g, '$1').toLowerCase()
    const rows = this.records
      .all(entity)
      .filter((r) => r.Active !== false)
      .filter((r) => !field || String(r[field] ?? '').toLowerCase() === value)
      .map((r) => this.view(entity, r))
    const page = rows.length ? { [entity]: rows, startPosition: 1, maxResults: rows.length } : {}
    return this.ok({ QueryResponse: page })
  }

  // Each listed entity's records changed after `changedSince`, compared at whole seconds: live
  // ones in their current state by LastUpdatedTime, then stubs of the deleted ones.
  private cdc(params: Params): QboResponse {
    const seconds = (t: Date | string) => Math.floor(new Date(t).getTime() / 1000)
    const since = seconds(params.changedSince ?? '')
    const entities = (params.entities ?? '').split(',').map(entityName)
    if (Number.isNaN(since) || !entities.every((e) => e !== undefined)) {
      throw new Error(`FakeQbo: unsupported cdc ${JSON.stringify(params)}`)
    }
    const QueryResponse = entities.map((entity) => {
      const updated = (r: Rec) => (r.MetaData as { LastUpdatedTime: string }).LastUpdatedTime
      const live = this.records
        .all(entity)
        .filter((r) => seconds(updated(r)) > since)
        .sort((a, b) => seconds(updated(a)) - seconds(updated(b)))
        .map((r) => this.view(entity, r))
      const deleted = this.changes
        .deletions(entity)
        .filter((c) => seconds(c.time) > since)
        .map((c) => ({
          domain: 'QBO',
          status: 'Deleted',
          Id: c.id,
          MetaData: { LastUpdatedTime: qboTime(c.time) },
        }))
      const rows = [...live, ...deleted]
      return rows.length ? { [entity]: rows, startPosition: 1, maxResults: rows.length } : {}
    })
    return this.ok({ CDCResponse: [{ QueryResponse }] })
  }

  // A response to a request that fails before reaching the record store.
  private failed(failure: Exclude<QboFailure, Failure> | 'unavailable'): QboResponse {
    const systemFault = (status: number) =>
      this.respond(status, {
        Fault: {
          Error: [{ Message: 'An application error has occurred', Detail: '', code: '10000' }],
          type: 'SystemFault',
        },
      })
    // 401 and 429 come from Intuit's gateway, in its lowercase envelope
    const gateway = (
      status: number,
      headers: Record<string, string>,
      error: Body,
      type: string
    ) => {
      const res = this.respond(status, {})
      const body = {
        fault: { error: [{ ...error, element: null }], type },
        time: this.now().getTime(),
      }
      return { ...res, headers: { ...res.headers, ...headers }, body }
    }
    switch (failure) {
      case 'unavailable':
        return systemFault(503)
      case 'http_500':
        return systemFault(500)
      case 'http_425':
        return { ...this.respond(425, {}), body: '' }
      case 'http_401':
        return gateway(
          401,
          { 'www-authenticate': 'Bearer realm="Intuit", error="invalid_token"' },
          {
            message: 'message=AuthenticationFailed; errorCode=003200; statusCode=401',
            detail: 'Token expired',
            code: '3200',
          },
          'AUTHENTICATION'
        )
      case 'http_429':
        return gateway(
          429,
          { 'retry-after': '1' },
          {
            message: 'message=ThrottleExceeded; errorCode=003001; statusCode=429',
            detail: 'The request limit was reached.  Try again later',
            code: '3001',
          },
          'SERVICE'
        )
    }
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
