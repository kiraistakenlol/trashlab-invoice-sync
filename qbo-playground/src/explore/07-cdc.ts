// Area 7: change data capture (`GET /cdc`). Response shape; how voided and deleted records
// appear; ordering; parameter limits (look-back, entity list); latency between a write and
// its appearance in CDC.
import { client } from '../setup.js'
import { marker, show } from './lib.js'

const qbo = client()
const m = marker('07')
const err = (b: any) => b.Fault?.Error?.map((e: any) => `${e.code} ${e.Message} | ${e.Detail}`)
const cdc = (entities: string, changedSince: string) =>
  qbo.request('GET', '/cdc', { query: { entities, changedSince } })
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const responses = (b: any) => b.CDCResponse?.[0]?.QueryResponse ?? []

// Shape over the last hour, with entity counts and the envelope keys
let res = await cdc('Invoice,Payment,Customer', iso(3600_000))
show(
  'cdc last hour: envelope',
  res,
  (b) =>
    err(b) ?? {
      keys: Object.keys(b),
      CDCResponse: b.CDCResponse?.map((r: any) => ({
        keys: Object.keys(r),
        QueryResponse: r.QueryResponse?.map((q: any) => ({
          keys: Object.keys(q),
          entities: Object.keys(q)
            .filter((k) => /^[A-Z]/.test(k))
            .map((k) => `${k}:${q[k].length}`),
          startPosition: q.startPosition,
          maxResults: q.maxResults,
          totalCount: q.totalCount,
        })),
      })),
    }
)
const groups = responses(res.body)
const invoices: any[] = groups.find((g: any) => g.Invoice)?.Invoice ?? []
const payments: any[] = groups.find((g: any) => g.Payment)?.Payment ?? []
console.log(
  '\ninvoice order (Id@LastUpdated):',
  invoices.map((i) => `${i.Id}@${i.MetaData?.LastUpdatedTime?.slice(11, 19)}`).join(' ')
)
console.log(
  '\ndeleted invoices as returned:',
  JSON.stringify(invoices.filter((i) => i.status === 'Deleted'))
)
console.log(
  '\nstatus values seen:',
  JSON.stringify([...new Set([...invoices, ...payments].map((x) => x.status ?? '(none)'))])
)
const voided = invoices.find((i) => i.PrivateNote?.startsWith('Voided'))
console.log(
  '\na voided invoice as returned (keys + note):',
  voided &&
    JSON.stringify({
      Id: voided.Id,
      status: voided.status,
      PrivateNote: voided.PrivateNote,
      TotalAmt: voided.TotalAmt,
      keys: Object.keys(voided),
    })
)
const live = invoices.find((i) => i.status !== 'Deleted')
const liveGet = ((await qbo.request('GET', `/invoice/${live.Id}`)).body as any).Invoice
console.log(
  '\nCDC record vs GET for invoice',
  live.Id,
  '- same JSON (ignoring key order)?',
  JSON.stringify(Object.keys(live).sort()) === JSON.stringify(Object.keys(liveGet).sort()),
  '; missing in CDC:',
  Object.keys(liveGet).filter((k) => !(k in live)),
  '; extra in CDC:',
  Object.keys(live).filter((k) => !(k in liveGet))
)
const deletedPay = payments.filter((p) => p.status === 'Deleted')
console.log('deleted payments:', JSON.stringify(deletedPay))

// Parameter edges
for (const [label, ents, since] of [
  ['changedSince 29 days ago', 'Invoice', iso(29 * 86400_000)],
  ['changedSince 31 days ago', 'Invoice', iso(31 * 86400_000)],
  ['changedSince in the future', 'Invoice', iso(-3600_000)],
  ['changedSince date only', 'Invoice', new Date().toISOString().slice(0, 10)],
  ['changedSince with offset', 'Invoice', '2026-10-16T06:00:00-07:00'],
  ['no changedSince', 'Invoice', ''],
  ['unknown entity', 'Invoice,Bogus', iso(60_000)],
  ['lowercase entity', 'invoice', iso(600_000)],
  ['other entities', 'Account,Item,JournalEntry,CreditMemo', iso(86400_000)],
] as const) {
  res = since
    ? await cdc(ents, since)
    : await qbo.request('GET', '/cdc', { query: { entities: ents } })
  show(
    label,
    res,
    (b) =>
      err(b) ??
      responses(b).map(
        (q: any) =>
          Object.keys(q)
            .filter((k) => /^[A-Z]/.test(k))
            .map((k) => `${k}:${q[k].length}`)
            .join(',') || '(empty group)'
      )
  )
}

// Latency: write, then poll CDC every second until the change shows up
const cust = (
  (await qbo.request('POST', '/customer', { body: { DisplayName: `${m}-cust` } })).body as any
).Customer
const before = new Date(Date.now() - 2000).toISOString()
const created = (
  (
    await qbo.request('POST', '/invoice', {
      body: {
        CustomerRef: { value: cust.Id },
        Line: [
          {
            Amount: 1,
            DetailType: 'SalesItemLineDetail',
            SalesItemLineDetail: { ItemRef: { value: '1' } },
          },
        ],
      },
    })
  ).body as any
).Invoice
const t0 = Date.now()
for (let i = 0; i < 30; i++) {
  const found = (
    (responses((await cdc('Invoice', before)).body).find((g: any) => g.Invoice)?.Invoice ??
      []) as any[]
  ).find((x) => x.Id === created.Id)
  if (found) {
    console.log(
      `\ncreated invoice ${created.Id} visible in CDC after ${Date.now() - t0} ms (SyncToken ${found.SyncToken})`
    )
    break
  }
  await sleep(1000)
}
await qbo.request('POST', '/invoice', {
  query: { operation: 'delete' },
  body: { Id: created.Id, SyncToken: created.SyncToken },
})
const t1 = Date.now()
for (let i = 0; i < 30; i++) {
  const found = (
    (responses((await cdc('Invoice', before)).body).find((g: any) => g.Invoice)?.Invoice ??
      []) as any[]
  ).find((x) => x.Id === created.Id)
  if (found?.status === 'Deleted') {
    console.log(`its delete visible after ${Date.now() - t1} ms:`, JSON.stringify(found))
    break
  }
  await sleep(1000)
}
