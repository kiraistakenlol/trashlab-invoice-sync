// Area 7 follow-up: look-back beyond 30 days, the error for a missing changedSince, one
// entry per record or per change, inactive customers, why Accounts show up, and the
// changedSince boundary precision.
import { client } from '../setup.js'
import { show } from './lib.js'

const qbo = client()
const err = (b: any) => b.Fault?.Error?.map((e: any) => `${e.code} ${e.Message} | ${e.Detail}`)
const cdc = (entities: string, changedSince: string) =>
  qbo.request('GET', '/cdc', { query: { entities, changedSince } })
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()
const group = (b: any, name: string): any[] =>
  b.CDCResponse?.[0]?.QueryResponse?.find((g: any) => g[name])?.[name] ?? []

for (const days of [45, 60, 365])
  show(
    `changedSince ${days} days ago`,
    await cdc('Invoice', iso(days * 86400_000)),
    (b) => err(b) ?? `Invoice:${group(b, 'Invoice').length}`
  )
show(
  'no changedSince (full body)',
  await qbo.request('GET', '/cdc', { query: { entities: 'Invoice' } })
)
show('no entities', await qbo.request('GET', '/cdc', { query: { changedSince: iso(60_000) } }), err)

let res = await cdc('Invoice,Customer,Account', iso(7200_000))
const invs = group(res.body, 'Invoice')
console.log('\ninvoices:', invs.length, 'unique ids:', new Set(invs.map((i) => i.Id)).size)
const custs = group(res.body, 'Customer')
console.log(
  'customers:',
  custs.length,
  'inactive:',
  JSON.stringify(custs.filter((c) => c.Active === false).map((c) => `${c.Id}:${c.DisplayName}`))
)
console.log(
  'accounts:',
  JSON.stringify(
    group(res.body, 'Account').map((a) => ({
      Id: a.Id,
      Name: a.Name,
      AccountType: a.AccountType,
      CurrentBalance: a.CurrentBalance,
      LastUpdated: a.MetaData?.LastUpdatedTime,
    }))
  )
)

// Boundary: a record's LastUpdatedTime as changedSince, then +1 s, +500 ms
const sample = invs.find((i) => i.status !== 'Deleted')
const t = new Date(sample.MetaData.LastUpdatedTime).getTime()
for (const [label, ms] of [
  ['= LastUpdatedTime', 0],
  ['+ 500 ms', 500],
  ['+ 1 s', 1000],
  ['- 1 s', -1000],
] as const) {
  res = await cdc('Invoice', new Date(t + ms).toISOString())
  console.log(
    `changedSince ${label} (invoice ${sample.Id} @ ${sample.MetaData.LastUpdatedTime}): included = ${group(res.body, 'Invoice').some((i) => i.Id === sample.Id)}`
  )
}
