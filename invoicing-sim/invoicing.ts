// In-memory invoicing system implementing the assumed contract, with failures a test can arm.
import { randomUUID } from 'node:crypto'
import type { InvoicingClient } from '../src/invoicing/client.js'
import { InvoicingApiError } from '../src/invoicing/errors.js'
import type {
  Account,
  AccountInput,
  CatalogueUpdate,
  Customer,
  CustomerInput,
  Invoice,
  InvoiceInput,
  InvoiceLine,
  InvoiceReplace,
  InvoicingEntityType,
  InvoicingEvent,
  InvoicingEventKind,
  Item,
  ItemInput,
  Payment,
  PaymentInput,
} from '../src/invoicing/types.js'
import { add, cmp, lineAmount, sub } from '../src/money.js'

const MAX_NUMBER_LENGTH = 21

export type InvoicingFailure = 'timeout_before_write' | 'timeout_after_write' | 'unavailable'

// the error AbortSignal.timeout produces
const timeoutError = () =>
  new DOMException('The operation was aborted due to timeout', 'TimeoutError')

type Catalogue = Account | Item | Customer
type EntityType = InvoicingEntityType
type ChangeKind = InvoicingEventKind

type InvoiceRecord = Omit<Invoice, 'paid' | 'balance' | 'status'>

type PaymentRecord = Omit<Payment, 'unapplied'>

type Stored = Catalogue | InvoiceRecord | PaymentRecord

const OPS = [
  'getAccount',
  'listAccounts',
  'createAccount',
  'updateAccount',
  'getItem',
  'listItems',
  'createItem',
  'updateItem',
  'getCustomer',
  'listCustomers',
  'createCustomer',
  'updateCustomer',
  'getInvoice',
  'listInvoices',
  'createInvoice',
  'replaceInvoice',
  'voidInvoice',
  'deleteInvoice',
  'getPayment',
  'listPayments',
  'createPayment',
  'replacePayment',
  'deletePayment',
  'listEvents',
] as const satisfies readonly (keyof InvoicingClient)[]

type Op = keyof InvoicingClient
type Method = (...args: unknown[]) => Promise<unknown>

const clone = <T>(x: T): T => structuredClone(x)

const canonical = (x: unknown): string =>
  JSON.stringify(x, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v
  )

const violation = (message: string) => new InvoicingApiError(422, 'rule_violation', message)

export class InMemoryInvoicing implements InvoicingClient {
  private readonly now: () => Date
  private readonly accounts = new Map<string, Account>()
  private readonly items = new Map<string, Item>()
  private readonly customers = new Map<string, Customer>()
  private readonly invoices = new Map<string, InvoiceRecord>()
  private readonly payments = new Map<string, PaymentRecord>()
  private readonly idempotency = new Map<string, { bodyJson: string; response: unknown }>()
  private nextNumber = 1
  private readonly events: InvoicingEvent[] = []
  private delivered = 0
  private readonly failures = new Map<Op, InvoicingFailure[]>()
  private readonly numberPrefix: string
  private readonly onEvent: (event: InvoicingEvent) => void

  // `onEvent` sees every change as it is recorded
  constructor(
    opts: {
      now?: () => Date
      numberPrefix?: string
      onEvent?: (event: InvoicingEvent) => void
    } = {}
  ) {
    this.now = opts.now ?? (() => new Date())
    this.numberPrefix = opts.numberPrefix ?? 'INV-'
    this.onEvent = opts.onEvent ?? (() => undefined)
    for (const op of OPS) this.withFailures(op)
  }

  // Arms the next call of op to fail once; arming twice queues both
  failNext(op: Op, failure: InvoicingFailure): void {
    this.failures.set(op, [...(this.failures.get(op) ?? []), failure])
  }

  // Returns and clears the events not yet delivered, as a lossy, unordered webhook channel would
  takeWebhooks(
    opts: {
      duplicate?: boolean
      reverse?: boolean
      drop?: (e: InvoicingEvent) => boolean
    } = {}
  ): InvoicingEvent[] {
    let out = this.events.slice(this.delivered).map((e) => ({ ...e }))
    this.delivered = this.events.length
    if (opts.drop) out = out.filter((e) => !opts.drop!(e))
    if (opts.duplicate) out = out.flatMap((e) => [e, { ...e }])
    if (opts.reverse) out.reverse()
    return out
  }

  async listEvents(after: string | null, limit = 100): Promise<InvoicingEvent[]> {
    return this.events
      .filter((e) => after === null || e.id > after)
      .slice(0, limit)
      .map((e) => ({ ...e }))
  }

  private withFailures(op: Op): void {
    const self = this as unknown as Record<Op, Method>
    const original = self[op].bind(this)
    self[op] = async (...args) => {
      const failure = this.failures.get(op)?.shift()
      if (failure === 'unavailable') throw new InvoicingApiError(503, 'unavailable', 'unavailable')
      if (failure === 'timeout_before_write') throw timeoutError()
      // a read has nothing to apply, so this equals timing out before it
      const result = await original(...args)
      if (failure === 'timeout_after_write') throw timeoutError()
      return result
    }
  }

  // Every successful write of any entity goes through here
  private commit(entityType: EntityType, record: Stored, kind: ChangeKind): void {
    const store = this.stores[entityType] as Map<string, Stored>
    store.set(record.id, record)
    const event: InvoicingEvent = {
      id: `evt_${String(this.events.length + 1).padStart(6, '0')}`,
      entityType,
      entityId: record.id,
      kind,
      version: record.version,
    }
    this.events.push(event)
    this.onEvent({ ...event })
  }

  private get stores() {
    return {
      account: this.accounts,
      item: this.items,
      customer: this.customers,
      invoice: this.invoices,
      payment: this.payments,
    }
  }

  private stamp(): string {
    return this.now().toISOString()
  }

  private idempotent<T>(key: string, body: unknown, create: () => T): T {
    const bodyJson = canonical(body)
    const seen = this.idempotency.get(key)
    if (seen) {
      if (seen.bodyJson !== bodyJson) {
        throw new InvoicingApiError(
          409,
          'idempotency_mismatch',
          `key ${key} used with another body`
        )
      }
      return clone(seen.response as T)
    }
    const response = create()
    this.idempotency.set(key, { bodyJson, response: clone(response) })
    return response
  }

  // Catalogue

  private assertUniqueName(store: Map<string, Catalogue>, name: string, selfId?: string): void {
    const lower = name.toLowerCase()
    for (const r of store.values()) {
      if (r.id !== selfId && r.name.toLowerCase() === lower) {
        throw violation(`name "${name}" is taken`)
      }
    }
  }

  private createCatalogue<T extends Catalogue>(
    entityType: EntityType,
    store: Map<string, T>,
    key: string,
    input: { name: string },
    build: (base: { id: string; version: 1; createdAt: string; updatedAt: string }) => T
  ): T {
    return this.idempotent(key, input, () => {
      this.assertUniqueName(store, input.name)
      const at = this.stamp()
      const record = build({ id: randomUUID(), version: 1, createdAt: at, updatedAt: at })
      this.commit(entityType, record, 'created')
      return clone(record)
    })
  }

  private updateCatalogue<T extends Catalogue>(
    entityType: EntityType,
    store: Map<string, T>,
    id: string,
    patch: CatalogueUpdate<Partial<T>>,
    version: number
  ): T {
    const current = store.get(id)
    if (!current) throw new InvoicingApiError(404, 'not_found', `${id} not found`)
    if (current.version !== version) {
      throw new InvoicingApiError(409, 'version_conflict', `current version is ${current.version}`)
    }
    const { deactivated, ...given } = patch
    const fields = Object.fromEntries(
      Object.entries(given).filter(([, v]) => v !== undefined)
    ) as Partial<T>
    if (fields.name !== undefined) this.assertUniqueName(store, fields.name, id)
    const at = this.stamp()
    const next: T = {
      ...current,
      ...fields,
      id,
      version: current.version + 1,
      updatedAt: at,
      deactivatedAt: deactivated === undefined ? current.deactivatedAt : deactivated ? at : null,
    }
    this.commit(entityType, next, 'updated')
    return clone(next)
  }

  private assertAccount(id: string): void {
    if (!this.accounts.has(id)) throw violation(`unknown account ${id}`)
  }

  async getAccount(id: string): Promise<Account | null> {
    return clone(this.accounts.get(id) ?? null)
  }
  async listAccounts(): Promise<Account[]> {
    return clone([...this.accounts.values()])
  }
  async createAccount(input: AccountInput, key: string): Promise<Account> {
    return this.createCatalogue('account', this.accounts, key, input, (base) => ({
      ...base,
      name: input.name,
      deactivatedAt: null,
    }))
  }
  async updateAccount(
    id: string,
    patch: CatalogueUpdate<AccountInput>,
    version: number
  ): Promise<Account> {
    return this.updateCatalogue('account', this.accounts, id, patch, version)
  }

  async getItem(id: string): Promise<Item | null> {
    return clone(this.items.get(id) ?? null)
  }
  async listItems(): Promise<Item[]> {
    return clone([...this.items.values()])
  }
  async createItem(input: ItemInput, key: string): Promise<Item> {
    return this.createCatalogue('item', this.items, key, input, (base) => {
      this.assertAccount(input.incomeAccountId)
      return { ...base, ...input, deactivatedAt: null }
    })
  }
  async updateItem(id: string, patch: CatalogueUpdate<ItemInput>, version: number): Promise<Item> {
    if (patch.incomeAccountId !== undefined) this.assertAccount(patch.incomeAccountId)
    return this.updateCatalogue('item', this.items, id, patch, version)
  }

  async getCustomer(id: string): Promise<Customer | null> {
    return clone(this.customers.get(id) ?? null)
  }
  async listCustomers(): Promise<Customer[]> {
    return clone([...this.customers.values()])
  }
  async createCustomer(input: CustomerInput, key: string): Promise<Customer> {
    return this.createCatalogue('customer', this.customers, key, input, (base) => ({
      ...base,
      name: input.name,
      email: input.email ?? null,
      deactivatedAt: null,
    }))
  }
  async updateCustomer(
    id: string,
    patch: CatalogueUpdate<CustomerInput>,
    version: number
  ): Promise<Customer> {
    return this.updateCatalogue('customer', this.customers, id, patch, version)
  }

  // Invoices

  private paidFor(invoiceId: string): string {
    const amounts: string[] = []
    for (const p of this.payments.values()) {
      if (p.deletedAt) continue
      for (const a of p.allocations) if (a.invoiceId === invoiceId) amounts.push(a.amount)
    }
    return add('0.00', ...amounts)
  }

  private view(r: InvoiceRecord): Invoice {
    const paid = this.paidFor(r.id)
    const balance = sub(r.total, paid)
    const status = r.deletedAt
      ? 'deleted'
      : r.voidedAt
        ? 'void'
        : cmp(paid, '0.00') === 0
          ? 'open'
          : cmp(balance, '0.00') === 0
            ? 'paid'
            : 'partly_paid'
    return clone({ ...r, paid, balance, status })
  }

  private buildLines(inputs: InvoiceInput['lines'], existing: InvoiceLine[] = []): InvoiceLine[] {
    if (inputs.length === 0) throw violation('an invoice needs at least one line')
    const known = new Set(existing.map((l) => l.id))
    return inputs.map((l) => {
      if (l.id !== undefined && !known.has(l.id)) throw violation(`unknown line ${l.id}`)
      if (!this.items.has(l.itemId)) throw violation(`unknown item ${l.itemId}`)
      if (!/^\d+(\.\d+)?$/.test(l.quantity) || cmp(l.quantity, '0') <= 0) {
        throw violation(`quantity ${l.quantity} must be a decimal above 0`)
      }
      this.money(l.unitPrice, 'unitPrice')
      this.money(l.amount, 'amount')
      if (lineAmount(l.quantity, l.unitPrice) !== l.amount) {
        throw violation(`line amount ${l.amount} is not ${l.quantity} x ${l.unitPrice}`)
      }
      return {
        id: l.id ?? randomUUID(),
        itemId: l.itemId,
        description: l.description ?? null,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        amount: l.amount,
      }
    })
  }

  private money(value: string, field: string): void {
    if (!/^-?\d+\.\d{2}$/.test(value)) throw violation(`${field} must be a 2-place decimal`)
  }

  private header(input: InvoiceReplace, existing?: InvoiceLine[]) {
    if (!this.customers.has(input.customerId))
      throw violation(`unknown customer ${input.customerId}`)
    const lines = this.buildLines(input.lines, existing)
    const tax = input.tax ?? '0.00'
    this.money(tax, 'tax')
    const total = add(...lines.map((l) => l.amount), tax)
    if (cmp(total, '0.00') < 0) throw violation('total must not be negative')
    return {
      customerId: input.customerId,
      issueDate: input.issueDate,
      dueDate: input.dueDate,
      memo: input.memo ?? null,
      lines,
      tax,
      total,
    }
  }

  private numberTaken(number: string, selfId?: string): boolean {
    const lower = number.toLowerCase()
    return [...this.invoices.values()].some(
      (i) => i.id !== selfId && i.number.toLowerCase() === lower
    )
  }

  private generateNumber(): string {
    for (;;) {
      const number = `${this.numberPrefix}${String(this.nextNumber++).padStart(4, '0')}`
      if (!this.numberTaken(number)) return number
    }
  }

  private writable(id: string, version: number, allowVoid = false): InvoiceRecord {
    const r = this.invoices.get(id)
    if (!r) throw new InvoicingApiError(404, 'not_found', `invoice ${id} not found`)
    if (r.deletedAt) throw violation('invoice is deleted')
    if (r.version !== version) {
      throw new InvoicingApiError(409, 'version_conflict', `current version is ${r.version}`)
    }
    if (r.voidedAt && !allowVoid) throw violation('invoice is void')
    return r
  }

  private save(r: InvoiceRecord, change: Partial<InvoiceRecord>, kind: ChangeKind): Invoice {
    const next: InvoiceRecord = { ...r, ...change, version: r.version + 1, updatedAt: this.stamp() }
    this.commit('invoice', next, kind)
    return this.view(next)
  }

  async getInvoice(id: string): Promise<Invoice | null> {
    const r = this.invoices.get(id)
    return r ? this.view(r) : null
  }

  async listInvoices(filter: { customerId?: string; number?: string } = {}): Promise<Invoice[]> {
    const number = filter.number?.toLowerCase()
    return [...this.invoices.values()]
      .filter((i) => filter.customerId === undefined || i.customerId === filter.customerId)
      .filter((i) => number === undefined || i.number.toLowerCase() === number)
      .map((i) => this.view(i))
  }

  async createInvoice(input: InvoiceInput, key: string): Promise<Invoice> {
    return this.idempotent(key, input, () => {
      const { number: given, ...rest } = input
      if (given !== undefined) {
        if (given.length > MAX_NUMBER_LENGTH) throw violation(`number exceeds ${MAX_NUMBER_LENGTH}`)
        if (this.numberTaken(given)) {
          throw new InvoicingApiError(409, 'number_taken', `number ${given} is taken`)
        }
      }
      const fields = this.header(rest)
      const at = this.stamp()
      const record: InvoiceRecord = {
        id: randomUUID(),
        number: given ?? this.generateNumber(),
        ...fields,
        version: 1,
        voidedAt: null,
        deletedAt: null,
        createdAt: at,
        updatedAt: at,
      }
      this.commit('invoice', record, 'created')
      return this.view(record)
    })
  }

  async replaceInvoice(id: string, input: InvoiceReplace, version: number): Promise<Invoice> {
    const r = this.writable(id, version)
    const fields = this.header(input, r.lines)
    const paid = this.paidFor(id)
    if (cmp(paid, '0.00') > 0) {
      if (fields.customerId !== r.customerId) {
        throw violation('invoice has allocations; its customer cannot change')
      }
      if (cmp(fields.total, paid) < 0) {
        throw violation(`total ${fields.total} is below the allocated ${paid}`)
      }
    }
    return this.save(r, fields, 'updated')
  }

  async voidInvoice(id: string, version: number): Promise<Invoice> {
    const r = this.writable(id, version)
    this.assertNoAllocations(id)
    return this.save(r, { voidedAt: this.stamp() }, 'voided')
  }

  async deleteInvoice(id: string, version: number): Promise<Invoice> {
    const r = this.writable(id, version, true)
    this.assertNoAllocations(id)
    return this.save(r, { deletedAt: this.stamp() }, 'deleted')
  }

  private assertNoAllocations(invoiceId: string): void {
    if (cmp(this.paidFor(invoiceId), '0.00') > 0) {
      throw violation('invoice has allocations; change the payments first')
    }
  }

  // Payments

  private paymentView(r: PaymentRecord): Payment {
    const unapplied = sub(r.amount, add('0.00', ...r.allocations.map((a) => a.amount)))
    return clone({ ...r, unapplied })
  }

  private paymentFields(input: PaymentInput, selfId?: string) {
    if (!this.customers.has(input.customerId)) {
      throw violation(`unknown customer ${input.customerId}`)
    }
    this.money(input.amount, 'amount')
    if (cmp(input.amount, '0.00') <= 0) throw violation('amount must be above 0')
    const seen = new Set<string>()
    for (const a of input.allocations) {
      this.money(a.amount, 'allocation amount')
      if (cmp(a.amount, '0.00') <= 0) throw violation('allocation amount must be above 0')
      if (seen.has(a.invoiceId)) throw violation(`invoice ${a.invoiceId} allocated twice`)
      seen.add(a.invoiceId)
      const inv = this.invoices.get(a.invoiceId)
      if (!inv) throw violation(`unknown invoice ${a.invoiceId}`)
      if (inv.deletedAt || inv.voidedAt)
        throw violation(`invoice ${a.invoiceId} is void or deleted`)
      if (inv.customerId !== input.customerId) {
        throw violation(`invoice ${a.invoiceId} belongs to another customer`)
      }
      const others = this.paidFor(a.invoiceId)
      const own = this.payments.get(selfId ?? '')
      const ownShare =
        own && !own.deletedAt ? own.allocations.find((x) => x.invoiceId === a.invoiceId) : undefined
      const rest = ownShare ? sub(others, ownShare.amount) : others
      if (cmp(add(rest, a.amount), inv.total) > 0) {
        throw violation(`allocations exceed the total of invoice ${a.invoiceId}`)
      }
    }
    if (cmp(add('0.00', ...input.allocations.map((a) => a.amount)), input.amount) > 0) {
      throw violation('allocations exceed the payment amount')
    }
    return {
      customerId: input.customerId,
      amount: input.amount,
      date: input.date,
      allocations: clone(input.allocations),
    }
  }

  private writablePayment(id: string, version: number): PaymentRecord {
    const r = this.payments.get(id)
    if (!r) throw new InvoicingApiError(404, 'not_found', `payment ${id} not found`)
    if (r.deletedAt) throw violation('payment is deleted')
    if (r.version !== version) {
      throw new InvoicingApiError(409, 'version_conflict', `current version is ${r.version}`)
    }
    return r
  }

  async getPayment(id: string): Promise<Payment | null> {
    const r = this.payments.get(id)
    return r ? this.paymentView(r) : null
  }

  async listPayments(filter: { customerId?: string } = {}): Promise<Payment[]> {
    return [...this.payments.values()]
      .filter((p) => filter.customerId === undefined || p.customerId === filter.customerId)
      .map((p) => this.paymentView(p))
  }

  async createPayment(input: PaymentInput, key: string): Promise<Payment> {
    return this.idempotent(key, input, () => {
      const fields = this.paymentFields(input)
      const at = this.stamp()
      const record: PaymentRecord = {
        id: randomUUID(),
        ...fields,
        version: 1,
        deletedAt: null,
        createdAt: at,
        updatedAt: at,
      }
      this.commit('payment', record, 'created')
      return this.paymentView(record)
    })
  }

  async replacePayment(id: string, input: PaymentInput, version: number): Promise<Payment> {
    const r = this.writablePayment(id, version)
    const next: PaymentRecord = {
      ...r,
      ...this.paymentFields(input, id),
      version: r.version + 1,
      updatedAt: this.stamp(),
    }
    this.commit('payment', next, 'updated')
    return this.paymentView(next)
  }

  async deletePayment(id: string, version: number): Promise<Payment> {
    const r = this.writablePayment(id, version)
    const next: PaymentRecord = {
      ...r,
      deletedAt: this.stamp(),
      version: r.version + 1,
      updatedAt: this.stamp(),
    }
    this.commit('payment', next, 'deleted')
    return this.paymentView(next)
  }
}
