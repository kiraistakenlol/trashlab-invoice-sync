// Area 8: webhooks. Performs labelled API writes (creates, updates, a no-op, void, delete,
// payment, journal entry, account), then watches webhooks.log (written by
// `pnpm webhooks`) for up to `waitMin` minutes and matches deliveries to the writes:
// which operations fire, payload format, batching, latency, signature, echoes of our own
// writes. Usage: pnpm qbo:explore 08-webhooks [waitMin=10]
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { client } from '../setup.js'
import { marker } from './lib.js'

const LOG_PATH = fileURLToPath(new URL('../../webhooks.log', import.meta.url))
const waitMin = Number(process.argv[2] ?? 10)
const qbo = client()
const m = marker('08')
const line = (amount: number) => ({
  Amount: amount,
  DetailType: 'SalesItemLineDetail',
  SalesItemLineDetail: { ItemRef: { value: '1' } },
})
const body = async (p: Promise<any>) => (await p).body as any
const post = (path: string, b: unknown, query?: Record<string, string>) =>
  body(qbo.request('POST', path, { body: b, query }))
const logLines = () =>
  existsSync(LOG_PATH)
    ? readFileSync(LOG_PATH, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : []
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface Action {
  label: string
  entity: string
  id: string
  at: number
  syncToken?: string
}
const actions: Action[] = []
const did = (label: string, entity: string, rec: any) => {
  actions.push({ label, entity, id: rec.Id, at: Date.now(), syncToken: rec.SyncToken })
  console.log(
    `${new Date().toISOString()} ${label}: ${entity} ${rec.Id} (SyncToken ${rec.SyncToken ?? '-'})`
  )
}

const before = logLines().length
const cust = (await post('/customer', { DisplayName: `${m}-cust` })).Customer
did('customer create', 'Customer', cust)
let inv = (
  await post('/invoice', { CustomerRef: { value: cust.Id }, DocNumber: 'W08-a', Line: [line(100)] })
).Invoice
did('invoice create', 'Invoice', inv)
await sleep(5000)
inv = (
  await post('/invoice', {
    Id: inv.Id,
    SyncToken: inv.SyncToken,
    sparse: true,
    PrivateNote: `${m}-edit`,
  })
).Invoice
did('invoice sparse update', 'Invoice', inv)
await sleep(5000)
inv = (await post('/invoice', { Id: inv.Id, SyncToken: inv.SyncToken, sparse: true })).Invoice
did('invoice no-op update', 'Invoice', inv)
await sleep(5000)
const pay = (
  await post('/payment', {
    CustomerRef: { value: cust.Id },
    TotalAmt: 40,
    Line: [{ Amount: 40, LinkedTxn: [{ TxnId: inv.Id, TxnType: 'Invoice' }] }],
  })
).Payment
did('payment create (applied to invoice a)', 'Payment', pay)
await sleep(5000)
const v = (
  await post('/invoice', { CustomerRef: { value: cust.Id }, DocNumber: 'W08-v', Line: [line(10)] })
).Invoice
did('invoice create (to void)', 'Invoice', v)
await sleep(3000)
did(
  'invoice void',
  'Invoice',
  (await post('/invoice', { Id: v.Id, SyncToken: v.SyncToken }, { operation: 'void' })).Invoice
)
await sleep(5000)
const d = (
  await post('/invoice', { CustomerRef: { value: cust.Id }, DocNumber: 'W08-d', Line: [line(10)] })
).Invoice
did('invoice create (to delete)', 'Invoice', d)
await sleep(3000)
did(
  'invoice delete',
  'Invoice',
  (await post('/invoice', { Id: d.Id, SyncToken: d.SyncToken }, { operation: 'delete' })).Invoice
)
await sleep(5000)
const p2 = (
  await post('/payment', {
    CustomerRef: { value: cust.Id },
    TotalAmt: 5,
    Line: [{ Amount: 5, LinkedTxn: [{ TxnId: inv.Id, TxnType: 'Invoice' }] }],
  })
).Payment
did('payment create (to void)', 'Payment', p2)
await sleep(3000)
did(
  'payment void',
  'Payment',
  (
    await post(
      '/payment',
      { Id: p2.Id, SyncToken: p2.SyncToken, sparse: true },
      { operation: 'update', include: 'void' }
    )
  ).Payment
)
await sleep(5000)
did(
  'payment delete',
  'Payment',
  (await post('/payment', { Id: pay.Id, SyncToken: pay.SyncToken }, { operation: 'delete' }))
    .Payment
)
await sleep(5000)
const jl = (t: string, acct: string) => ({
  Amount: 3,
  DetailType: 'JournalEntryLineDetail',
  JournalEntryLineDetail: { PostingType: t, AccountRef: { value: acct } },
})
did(
  'journal entry create',
  'JournalEntry',
  (
    await post('/journalentry', {
      PrivateNote: `${m}-je`,
      Line: [jl('Debit', '4'), jl('Credit', '1')],
    })
  ).JournalEntry
)
did(
  'account create',
  'Account',
  (await post('/account', { Name: `${m}-acct`, AccountType: 'Income' })).Account
)
did(
  'customer sparse update',
  'Customer',
  (
    await post('/customer', {
      Id: cust.Id,
      SyncToken: cust.SyncToken,
      sparse: true,
      CompanyName: `${m} Co`,
    })
  ).Customer
)

// Normalise a delivery to events, whatever the format.
function events(entry: any): {
  entity: string
  id: string
  op: string
  lastUpdated?: string
  realm?: string
  extra?: unknown
}[] {
  let b: any
  try {
    b = JSON.parse(entry.body)
  } catch {
    return []
  }
  if (b.eventNotifications) {
    return b.eventNotifications.flatMap((n: any) =>
      (n.dataChangeEvent?.entities ?? []).map((e: any) => ({
        entity: e.name,
        id: e.id,
        op: e.operation,
        lastUpdated: e.lastUpdated,
        realm: n.realmId,
        extra: e.deletedId ? { deletedId: e.deletedId } : undefined,
      }))
    )
  }
  const list = Array.isArray(b) ? b : [b]
  return list.map((e: any) => ({
    entity: e.type?.split('.')[1] ?? '?',
    id: e.intuitentityid ?? e.data?.id ?? '?',
    op: e.type ?? '?',
    lastUpdated: e.time,
    realm: e.intuitaccountid,
    extra: { id: e.id },
  }))
}

const started = actions[0].at
const deadline = Date.now() + waitMin * 60_000
let seen = before
while (Date.now() < deadline) {
  const all = logLines()
  for (const entry of all.slice(seen)) {
    const evs = events(entry)
    console.log(
      `\n--- delivery at ${entry.receivedAt} (+${Math.round((Date.parse(entry.receivedAt) - started) / 1000)} s), sig=${entry.signatureValid}, ${evs.length} event(s), headers: ${JSON.stringify(Object.keys(entry.headers))}`
    )
    for (const e of evs) {
      const a = actions.filter(
        (x) => x.entity.toLowerCase() === e.entity.toLowerCase() && x.id === e.id
      )
      console.log(
        `  ${e.entity} ${e.id} ${e.op} lastUpdated=${e.lastUpdated} ${e.extra ? JSON.stringify(e.extra) : ''} <- ${a.map((x) => x.label).join(' / ') || '(no matching action)'}`
      )
    }
    if (seen === before) {
      console.log('  first raw body:', entry.body.slice(0, 1500))
    }
  }
  seen = all.length
  await sleep(5000)
}
console.log(`\nactions: ${JSON.stringify(actions.map((a) => `${a.label}=${a.entity} ${a.id}`))}`)
