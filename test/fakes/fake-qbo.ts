// In-memory QBO Accounting API behind the QboClient transport interface.
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { QboClient, QboResponse, RequestOptions } from '../../src/qbo/client.js'
import type { QboEntityName, QboPayment } from '../../src/qbo/entities.js'
import { add, cmp, isZero, min, sub, toMoney, type Money } from '../../src/money.js'

type Rec = Record<string, unknown> & { Id: string; SyncToken: string }
type Body = Record<string, unknown>
type Line = Record<string, unknown>
type PaymentLine = QboPayment['Line'][number]
type Params = Record<string, string>
type Operation = 'Create' | 'Update' | 'Void' | 'Delete'

const ENTITIES: QboEntityName[] = ['Customer', 'Account', 'Item', 'Invoice', 'Payment']
const FIRST_ID = 1000
const FIRST_DOC_NUMBER = 1001
const COMPANY_OFFSET_HOURS = -7
const DEFAULT_TERMS_DAYS = 30
const MAX_REQUEST_ID = 50
const ZERO: Money = '0.00'
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
  private readonly replays = new Map<string, { entity: QboEntityName; response: QboResponse }>()

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
      if (entity && rest.length === 0) {
        if (method === 'GET' && id && Object.keys(params).length === 0) {
          return this.ok({ [entity]: this.view(entity, this.find(entity, id)) })
        }
        const operation = method === 'POST' && !id && this.operation(entity, params, body)
        if (operation) {
          return this.once(entity, params.requestid, () => this.write(entity, operation, body))
        }
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
    const saved = this.save(entity, { Id: id, ...fields })
    if (entity === 'Payment') this.bumpInvoices([], saved.Line)
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
        CustomerRef: this.customerRef(body.CustomerRef),
        Line: this.lines(id, [], body.Line),
      }
    },
    Payment: (id, body) => ({
      TxnDate: this.today(),
      DepositToAccountRef: ref('4', 'Undeposited Funds'),
      ...this.writable(body),
      ...this.payment(id, body),
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
      next.CustomerRef = this.customerRef(next.CustomerRef)
      if (body.Line !== undefined) next.Line = this.lines(current.Id, current.Line, body.Line)
    }
    if (entity === 'Payment') Object.assign(next, this.payment(current.Id, { ...current, ...body }))
    // a ref's name follows renames of the customer; only its value identifies the customer
    const refValue = (r: unknown) => (r as { value?: string } | undefined)?.value
    const sameCustomer = refValue(next.CustomerRef) === refValue(current.CustomerRef)
    if (sameCustomer && current.CustomerRef) next.CustomerRef = current.CustomerRef
    if (isDeepStrictEqual(next, current)) return this.view(entity, current)
    const saved = this.save(entity, next)
    if (entity === 'Invoice') this.refit(saved.Id, sameCustomer ? this.total(saved) : ZERO)
    if (entity === 'Payment') this.bumpInvoices(current.Line, saved.Line)
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
    const saved = this.save('Invoice', { ...current, Line, PrivateNote })
    this.refit(saved.Id, ZERO)
    return this.view('Invoice', saved)
  }

  private voidPayment(body: Body): Body {
    const current = this.current('Payment', body)
    const saved = this.save('Payment', { ...current, TotalAmt: 0, Line: [], PrivateNote: 'Voided' })
    this.bumpInvoices(current.Line, [])
    return this.view('Payment', saved)
  }

  // Delete checks that a SyncToken is sent, not that it is current.
  private remove(entity: QboEntityName, body: Body): Body {
    if (body.SyncToken === undefined) throw new Fault('2020', 'Required param missing', 'SyncToken')
    const current = this.find(entity, String(body.Id))
    if (entity === 'Invoice') this.refit(current.Id, ZERO)
    if (entity === 'Payment') this.bumpInvoices(current.Line, [])
    this.store.get(entity)!.delete(current.Id)
    return { domain: 'QBO', status: 'Deleted', Id: current.Id }
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

  // The record a write targets, provided the write carries its current SyncToken.
  private current(entity: QboEntityName, body: Body): Rec {
    const rec = this.find(entity, String(body.Id))
    if (String(body.SyncToken) !== rec.SyncToken) throw new Fault('5010', 'Stale Object Error')
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

  // A payment's customer, amount and lines as stored: each line applied to one invoice of the
  // customer, clipped to that invoice's open balance; what is not applied stays unapplied.
  private payment(id: string, body: Body): Body {
    const CustomerRef = this.customerRef(body.CustomerRef)
    if (body.TotalAmt === undefined || body.TotalAmt === null) {
      throw new Fault('6000', "The Amount Received (plus credits) can't be less than the charges")
    }
    const total = toMoney(body.TotalAmt as number)
    if (cmp(total, ZERO) < 0) throw new Fault('2240', 'Number out of range', 'TotalAmt')
    if (isZero(total)) throw new Fault('6000', 'Enter a transaction amount')
    const sent = (body.Line ?? []) as Line[]
    if (cmp(add(...sent.map((l) => toMoney(l.Amount as number))), total) > 0) {
      throw new Fault('6000', "The Amount Received (plus credits) can't be less than the charges")
    }
    const Line = sent.flatMap((l): PaymentLine[] => {
      const txns = (l.LinkedTxn ?? []) as PaymentLine['LinkedTxn']
      if (txns.length !== 1) return [] // a line linking several invoices applies to none
      const invoice = this.find('Invoice', txns[0].TxnId)
      if ((invoice.CustomerRef as { value: string }).value !== CustomerRef.value) {
        throw new Fault('620', 'TxnID Cannot Be Linked')
      }
      const amount = min(toMoney(l.Amount as number), this.balance(invoice, id))
      if (cmp(amount, ZERO) <= 0) return []
      return [{ Amount: Number(amount), LinkedTxn: [{ TxnId: invoice.Id, TxnType: 'Invoice' }] }]
    })
    return { CustomerRef, TotalAmt: Number(total), Line }
  }

  // The amounts applied to an invoice, by payment, in payment order.
  private applications(invoiceId: string): { payment: Rec; amount: Money }[] {
    return [...this.store.get('Payment')!.values()].flatMap((payment) =>
      (payment.Line as PaymentLine[])
        .filter((l) => l.LinkedTxn[0].TxnId === invoiceId)
        .map((l) => ({ payment, amount: toMoney(l.Amount) }))
    )
  }

  private total(invoice: Rec): Money {
    return add(...(invoice.Line as Line[]).map((l) => toMoney(l.Amount as number)))
  }

  private balance(invoice: Rec, exceptPaymentId?: string): Money {
    const paid = this.applications(invoice.Id)
      .filter((a) => a.payment.Id !== exceptPaymentId)
      .map((a) => a.amount)
    return sub(this.total(invoice), add(...paid))
  }

  // Saves, and so bumps the SyncToken of, every invoice whose applied amount a payment write
  // changed.
  private bumpInvoices(before: unknown, after: unknown): void {
    const applied = (lines: unknown) =>
      new Map((lines as PaymentLine[]).map((l) => [l.LinkedTxn[0].TxnId, toMoney(l.Amount)]))
    const [was, now] = [applied(before), applied(after)]
    for (const id of new Set([...was.keys(), ...now.keys()])) {
      const invoice = this.store.get('Invoice')!.get(id)
      if (invoice && was.get(id) !== now.get(id)) this.save('Invoice', invoice)
    }
  }

  // Shrinks the payments applied to an invoice, in payment order, to fit within `cap`; the rest
  // of each becomes unapplied.
  private refit(invoiceId: string, cap: Money): void {
    let left = cap
    for (const { payment, amount } of this.applications(invoiceId)) {
      const keep = min(amount, left)
      left = sub(left, keep)
      if (keep === amount) continue
      const Line = (payment.Line as PaymentLine[]).flatMap((l) => {
        if (l.LinkedTxn[0].TxnId !== invoiceId) return [l]
        return isZero(keep) ? [] : [{ ...l, Amount: Number(keep) }]
      })
      this.save('Payment', { ...payment, Line })
    }
  }

  // A record as QBO returns it, with its computed fields.
  private view(entity: QboEntityName, rec: Rec): Body {
    if (entity === 'Payment') {
      const applied = add(...(rec.Line as PaymentLine[]).map((l) => toMoney(l.Amount)))
      const unapplied = sub(toMoney(rec.TotalAmt as number), applied)
      return structuredClone({ ...rec, UnappliedAmt: Number(unapplied) })
    }
    if (entity !== 'Invoice') return structuredClone(rec)
    const total = this.total(rec)
    return structuredClone({
      ...rec,
      Line: [
        ...(rec.Line as Line[]),
        { Amount: Number(total), DetailType: 'SubTotalLineDetail', SubTotalLineDetail: {} },
      ],
      TxnTaxDetail: { TotalTax: 0 },
      TotalAmt: Number(total),
      Balance: Number(this.balance(rec)),
      LinkedTxn: this.applications(rec.Id).map((a) => ({
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
