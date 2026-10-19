// End-to-end walk-through against a running sync service, the invoicing system and the QBO
// sandbox: a person edits each side, and the script waits for the sync to carry it over.
import { randomUUID } from 'node:crypto'
import { loadConfig } from '../src/config.js'
import { createInvoicingClient } from '../src/invoicing/http-client.js'
import type { Invoice } from '../src/invoicing/types.js'
import { createQboClient, fileTokenStore, QboApi } from '../src/qbo/index.js'
import type { QboInvoice } from '../src/qbo/entities.js'
import type { AuditRow } from '../src/store/audit.js'
import type { Issue } from '../src/store/issues.js'

const config = loadConfig(process.env)
const service = `http://localhost:${config.port}`
const invoicing = createInvoicingClient(config.invoicing)
const qbo = new QboApi(
  createQboClient({
    oauth: config.qbo.oauth,
    environment: config.qbo.environment,
    tokenStore: fileTokenStore(config.qbo.connectionFile),
  })
)
// a QBO edit reaches the sync through the next CDC poll
const WAIT_MS = 2 * config.pollIntervalMs + 30_000
const run = randomUUID().slice(0, 6)

const step = (text: string) => console.log(`\n== ${text}`)
const show = (text: string) => console.log(`   ${text}`)

async function api<T>(method: string, path: string, body?: object): Promise<T> {
  const res = await fetch(`${service}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(`${method} ${path} answered ${res.status}: ${await res.text()}`)
  return ((await res.json()) as { data: T }).data
}

async function until<T>(what: string, read: () => Promise<T | null | undefined | false>) {
  const started = Date.now()
  process.stdout.write(`   waiting for ${what} `)
  for (;;) {
    const value = await read()
    if (value) {
      console.log(`(${Math.round((Date.now() - started) / 1000)} s)`)
      return value
    }
    if (Date.now() - started > WAIT_MS) throw new Error(`gave up waiting for ${what}`)
    process.stdout.write('.')
    await new Promise((r) => setTimeout(r, 1000))
  }
}

const qboInvoice = async (number: string): Promise<QboInvoice | undefined> =>
  (await qbo.findInvoicesByNumber(number))[0]

async function editQboMemo(id: string, memo: string): Promise<void> {
  const current = (await qbo.get('Invoice', id))!
  await qbo.update('Invoice', {
    Id: id,
    SyncToken: current.SyncToken,
    CustomerMemo: { value: memo },
  })
}

async function editInvoicingMemo(invoice: Invoice, memo: string): Promise<Invoice> {
  const current = (await invoicing.getInvoice(invoice.id))!
  const { customerId, issueDate, dueDate, tax, lines } = current
  return invoicing.replaceInvoice(
    current.id,
    { customerId, issueDate, dueDate, tax, memo, lines },
    current.version
  )
}

step('Both systems are up')
show(`sync service ${(await api<{ status: string }>('GET', '/health')).status} on ${service}`)
show(`invoicing system on ${config.invoicing.baseUrl}`)

step('1. An invoice created in invoicing appears in QBO')
const account = await invoicing.createAccount({ name: `Demo Services ${run}` }, randomUUID())
const item = await invoicing.createItem(
  { name: `Demo Pickup ${run}`, incomeAccountId: account.id },
  randomUUID()
)
const customer = await invoicing.createCustomer({ name: `Demo Customer ${run}` }, randomUUID())
let invoice = await invoicing.createInvoice(
  {
    number: `DEMO-${run}`,
    customerId: customer.id,
    issueDate: new Date().toISOString().slice(0, 10),
    dueDate: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10),
    memo: 'Created in invoicing',
    lines: [{ itemId: item.id, quantity: '2', unitPrice: '50.00', amount: '100.00' }],
  },
  randomUUID()
)
show(`invoicing: invoice ${invoice.number}, total ${invoice.total}`)
const created = await until('the invoice in QBO', () => qboInvoice(invoice.number))
show(`QBO: invoice ${created.Id}, DocNumber ${created.DocNumber}, total ${created.TotalAmt}`)

step('2. An edit made in QBO reaches invoicing')
await editQboMemo(created.Id, 'Edited in QBO')
show('QBO: memo set to "Edited in QBO"')
invoice = await until('the memo in invoicing', async () => {
  const current = await invoicing.getInvoice(invoice.id)
  return current?.memo === 'Edited in QBO' && current
})
show(`invoicing: memo "${invoice.memo}"`)

step('3. A payment recorded in invoicing pays the QBO invoice')
await invoicing.createPayment(
  {
    customerId: customer.id,
    amount: '40.00',
    date: invoice.issueDate,
    allocations: [{ invoiceId: invoice.id, amount: '40.00' }],
  },
  randomUUID()
)
show('invoicing: payment of 40.00')
const paid = await until('the balance in QBO', async () => {
  const current = await qbo.get('Invoice', created.Id)
  return current?.Balance === 60 && current
})
show(`QBO: balance ${paid.Balance} of ${paid.TotalAmt}`)

step('4. The same field edited on both sides is a conflict, not a guess')
await editQboMemo(created.Id, 'QBO says ship Monday')
await editInvoicingMemo(invoice, 'Invoicing says ship Friday')
show('QBO: memo "QBO says ship Monday"; invoicing: memo "Invoicing says ship Friday"')
const issue = await until('the conflict', async () =>
  (await api<Issue[]>('GET', '/issues?open=true')).find(
    (i) => i.kind === 'conflict' && [invoice.id, created.Id].includes(i.ref.entityId)
  )
)
show(`issue ${issue.id}: ${JSON.stringify(issue.details.conflicts)}`)

step('5. An operator picks a side and the sync writes it')
await api('PATCH', `/issues/${issue.id}`, { resolution: 'invoicing' })
show(`PATCH /issues/${issue.id} {"resolution":"invoicing"}`)
await until('the memo in QBO', async () => {
  const current = await qbo.get('Invoice', created.Id)
  return current?.CustomerMemo?.value === 'Invoicing says ship Friday'
})
show('QBO: memo "Invoicing says ship Friday"')

step('6. The audit trail of the pair')
const audit = [
  ...(await api<AuditRow[]>(
    'GET',
    `/audit?system=invoicing&entityType=invoice&entityId=${invoice.id}`
  )),
  ...(await api<AuditRow[]>('GET', `/audit?system=qbo&entityType=invoice&entityId=${created.Id}`)),
].sort((a, b) => Number(a.id) - Number(b.id))
// notifications and the jobs that found nothing to do are counted; every other entry is shown
const quiet = audit.filter((e) => e.action === 'notification_received' || e.action === 'no_change')
const value = (v: unknown) => (typeof v === 'string' ? `"${v}"` : JSON.stringify(v))
for (const e of audit.filter((e) => !quiet.includes(e))) {
  const changes = Object.entries(e.changes ?? {})
  const what =
    e.action === 'updated'
      ? changes.map(([f, c]) => `${f} ${value(c.from)} -> ${value(c.to)}`).join(', ')
      : changes.map(([f]) => f).join(', ')
  show(
    `${e.ref.system.padEnd(9)} ${e.action.padEnd(14)} ${what}${e.error ? ` ERROR ${e.error}` : ''}`
  )
}
show(
  `plus ${quiet.filter((e) => e.action === 'notification_received').length} notifications ` +
    `and ${quiet.filter((e) => e.action === 'no_change').length} runs with nothing to do ` +
    "(echoes of the sync's own writes and repeats)"
)

step('Left in the QBO sandbox to look at')
show(`invoice ${created.DocNumber} (id ${created.Id}) for "Demo Customer ${run}", with its payment`)
