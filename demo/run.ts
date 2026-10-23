// End-to-end walk-through against a running sync service, the invoicing system and the QBO
// sandbox: a person edits each side, and the script waits for the sync to carry it over.
import { randomUUID } from 'node:crypto'
import { loadConfig } from '../src/config.js'
import { errorMessage } from '../src/error-message.js'
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
const STEPS = 5
const run = randomUUID().slice(0, 6)

const tty = process.stdout.isTTY
const paint = (code: number) => (text: string) => (tty ? `\x1b[${code}m${text}\x1b[0m` : text)
const [green, red, dim, bold] = [paint(32), paint(31), paint(2), paint(1)]

let current = 0
const step = (title: string) => console.log(`\n${bold(`${++current}/${STEPS}  ${title}`)}`)
const did = (text: string) => console.log(`      ${dim('›')} ${text}`)
const ok = (text: string) => console.log(`      ${green('✓')} ${text}`)

async function api<T>(method: string, path: string, body?: object): Promise<T> {
  const res = await fetch(`${service}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    throw new Error(`${method} ${path} answered ${res.status}: ${await res.text()}`)
  }
  return ((await res.json()) as { data: T }).data
}

// waits for the sync to have done something; `seen` describes the result once it is there
async function until<T>(
  what: string,
  read: () => Promise<T | null | undefined | false>,
  seen: (value: T) => string
): Promise<T> {
  const started = Date.now()
  process.stdout.write(`      ${dim(`… ${what} `)}`)
  for (;;) {
    const value = await read()
    if (value) {
      const seconds = Math.round((Date.now() - started) / 1000)
      if (tty) {
        process.stdout.write('\r\x1b[2K')
      } else {
        process.stdout.write('\n')
      }
      ok(`${seen(value)} ${dim(`(${seconds} s)`)}`)
      return value
    }
    if (Date.now() - started > WAIT_MS) {
      throw new Error(`gave up waiting for ${what}`)
    }
    process.stdout.write(dim('.'))
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

async function walkThrough(): Promise<void> {
  const health = await api<{ status: string }>('GET', '/health')
  console.log(
    dim(`sync service ${health.status} on ${service}, invoicing on ${config.invoicing.baseUrl}`)
  )

  step('Invoice created in invoicing → appears in QBO')
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
  did(`invoicing: invoice ${invoice.number}, 2 × 50.00, new customer and item`)
  const created = await until(
    'waiting for QBO',
    () => qboInvoice(invoice.number),
    (q) => `QBO: invoice ${q.DocNumber} (id ${q.Id}), total ${q.TotalAmt}`
  )

  step('Edit made in QBO → reaches invoicing')
  await editQboMemo(created.Id, 'Edited in QBO')
  did('QBO: memo → "Edited in QBO"')
  invoice = await until(
    'waiting for invoicing (QBO changes arrive by CDC polling)',
    async () => {
      const latest = await invoicing.getInvoice(invoice.id)
      return latest?.memo === 'Edited in QBO' && latest
    },
    (i) => `invoicing: memo "${i.memo}"`
  )

  step('Payment recorded in invoicing → pays the QBO invoice')
  await invoicing.createPayment(
    {
      customerId: customer.id,
      amount: '40.00',
      date: invoice.issueDate,
      allocations: [{ invoiceId: invoice.id, amount: '40.00' }],
    },
    randomUUID()
  )
  did('invoicing: payment of 40.00')
  await until(
    'waiting for QBO',
    async () => {
      const latest = await qbo.get('Invoice', created.Id)
      return latest?.Balance === 60 && latest
    },
    (q) => `QBO: balance ${q.Balance} of ${q.TotalAmt}`
  )

  step('Same field edited on both sides → conflict, nothing overwritten')
  await editQboMemo(created.Id, 'Ship Monday')
  await editInvoicingMemo(invoice, 'Ship Friday')
  did('QBO: memo → "Ship Monday";  invoicing: memo → "Ship Friday"')
  const issue = await until(
    'waiting for the sync to flag it',
    async () =>
      (await api<Issue[]>('GET', '/issues?open=true')).find(
        (i) => i.kind === 'conflict' && [invoice.id, created.Id].includes(i.ref.entityId)
      ),
    (i) =>
      `conflict on ${(i.details.conflicts as { field: string }[]).map((c) => c.field).join(', ')} flagged; neither side written`
  )

  step('Operator picks a side → the sync writes it')
  await api('PATCH', `/issues/${issue.id}`, { resolution: 'invoicing' })
  did(`PATCH /issues/${issue.id.slice(0, 8)}… {"resolution":"invoicing"}`)
  await until(
    'waiting for QBO',
    async () => {
      const latest = await qbo.get('Invoice', created.Id)
      return latest?.CustomerMemo?.value === 'Ship Friday' && latest
    },
    () => 'QBO: memo "Ship Friday"'
  )

  console.log(`\n${bold('Audit trail of the pair')}`)
  const audit = [
    ...(await api<AuditRow[]>(
      'GET',
      `/audit?system=invoicing&entityType=invoice&entityId=${invoice.id}`
    )),
    ...(await api<AuditRow[]>(
      'GET',
      `/audit?system=qbo&entityType=invoice&entityId=${created.Id}`
    )),
  ].sort((a, b) => Number(a.id) - Number(b.id))
  // notifications and the jobs that found nothing to do are counted; every other entry is shown
  const quiet = audit.filter(
    (e) => e.action === 'notification_received' || e.action === 'no_change'
  )
  const quote = (v: unknown) => (typeof v === 'string' ? `"${v}"` : JSON.stringify(v))
  for (const e of audit.filter((e) => !quiet.includes(e))) {
    const changes = Object.entries(e.changes ?? {})
    let what = ''
    if (e.action === 'updated') {
      what = changes.map(([f, c]) => `${f} ${quote(c.from)} → ${quote(c.to)}`).join(', ')
    } else if (e.action === 'created') {
      what = `${changes.length} fields`
    }
    console.log(`      ${e.ref.system.padEnd(9)} ${e.action.padEnd(14)} ${what}`)
    if (e.error) {
      console.log(`      ${' '.repeat(24)}${red(`↳ rejected: ${e.error}`)}`)
    }
  }
  const count = (action: string) => quiet.filter((e) => e.action === action).length
  console.log(
    dim(
      `      + ${count('notification_received')} notifications, ${count('no_change')} runs with` +
        ' nothing to do (echoes, repeats)'
    )
  )

  console.log(`\n${green(bold(`✓ All ${STEPS} steps passed`))}`)
  console.log(
    dim(`  In the QBO sandbox: invoice ${created.DocNumber} for "Demo Customer ${run}", paid 40.00`)
  )
}

try {
  await walkThrough()
} catch (err) {
  console.log(`\n${red(bold(`✗ Step ${current}/${STEPS} failed:`))} ${errorMessage(err)}`)
  process.exitCode = 1
}
