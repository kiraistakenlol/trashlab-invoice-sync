// Area 1 follow-up: minorversion shapes on more entities, timestamp filter precision and
// offsets, comparison operators, paging edges, default ordering, case sensitivity.
import { client } from '../setup.js'
import { show } from './lib.js'

const qbo = client()
const ids = (b: any, e: string) => (b.QueryResponse?.[e] ?? []).map((r: any) => r.Id)

// --- minorversion: field sets of one record per entity under null / 1 / 75 / 999
for (const entity of ['Customer', 'Payment', 'Item', 'Account']) {
  const one = (await qbo.query(`select * from ${entity} maxresults 1`)).body as any
  const id = one.QueryResponse[entity][0].Id
  const sets: Record<string, string> = {}
  for (const mv of [null, '1', '75', '999']) {
    const res = await client({ minorVersion: mv }).request('GET', `/${entity.toLowerCase()}/${id}`)
    sets[String(mv)] = JSON.stringify(Object.keys((res.body as any)[entity]).sort())
  }
  const distinct = new Set(Object.values(sets))
  console.log(
    `\n=== ${entity} ${id}: ${distinct.size === 1 ? 'same field set for all minorversions' : 'DIFFERENT'}`
  )
  if (distinct.size > 1) {
    console.log(sets)
  }
}

// --- Timestamp filter precision, using the most recently updated invoice as the boundary
const latest = (
  (await qbo.query('select * from Invoice orderby MetaData.LastUpdatedTime desc maxresults 1'))
    .body as any
).QueryResponse.Invoice[0]
const t: string = latest.MetaData.LastUpdatedTime // e.g. 2026-09-19T13:16:17-07:00
const utc = new Date(t).toISOString().replace('.000Z', 'Z')
console.log(`\nboundary: invoice ${latest.Id} LastUpdatedTime ${t} (= ${utc})`)
const cases: [string, string][] = [
  ['= t', `= '${t}'`],
  ['>= t', `>= '${t}'`],
  ['> t', `> '${t}'`],
  ['>= t in UTC (Z)', `>= '${utc}'`],
  ['> t in UTC (Z)', `> '${utc}'`],
  ['> t - 1s', `> '${new Date(new Date(t).getTime() - 1000).toISOString()}'`],
  ['>= t + 500ms', `>= '${new Date(new Date(t).getTime() + 500).toISOString()}'`],
  ['> t - 500ms', `> '${new Date(new Date(t).getTime() - 500).toISOString()}'`],
  ['date only >= day', `>= '${t.slice(0, 10)}'`],
  ['< t', `< '${t}'`],
  ['<= t', `<= '${t}'`],
]
for (const [label, cond] of cases) {
  const res = await qbo.query(`select * from Invoice where MetaData.LastUpdatedTime ${cond}`)
  const got = ids(res.body, 'Invoice')
  console.log(
    `${label.padEnd(20)} status ${res.status} rows ${got.length} includes ${latest.Id}: ${got.includes(latest.Id)}${res.status !== 200 ? ' ' + JSON.stringify((res.body as any).Fault) : ''}`
  )
}
show(
  'BETWEEN (expected unsupported)',
  await qbo.query(`select Id from Invoice where TotalAmt between '1' and '100'`)
)
show(
  '!= operator',
  await qbo.query(`select Id from Invoice where DocNumber != '1001' maxresults 2`),
  (b) => b.QueryResponse ?? b
)

// --- Paging edges
for (const q of [
  'select Id from Invoice maxresults 0',
  'select Id from Invoice startposition 0 maxresults 2',
  'select Id from Invoice startposition -1 maxresults 2',
  'select Id from Invoice startposition 1000 maxresults 2',
]) {
  show(q, await qbo.query(q), (b) =>
    b.QueryResponse ? { ids: ids(b, 'Invoice'), ...b.QueryResponse, Invoice: undefined } : b
  )
}

// --- Default order: no orderby, twice, vs orderby Id / orderby LastUpdatedTime
const a = ids((await qbo.query('select Id from Invoice')).body, 'Invoice')
const b2 = ids((await qbo.query('select Id from Invoice')).body, 'Invoice')
const byId = ids((await qbo.query('select Id from Invoice orderby Id')).body, 'Invoice')
const byCreate = ids(
  (await qbo.query('select Id from Invoice orderby MetaData.CreateTime desc')).body,
  'Invoice'
)
console.log('\n=== default order')
console.log('no orderby #1   ', a.join(','))
console.log('no orderby #2   ', b2.join(','))
console.log('orderby Id      ', byId.join(','))
console.log('orderby Create d', byCreate.join(','))

// --- Case sensitivity
for (const q of [
  "SELECT * FROM Invoice WHERE DocNumber = '1001'",
  "select * from invoice where DocNumber = '1001'",
  "select * from Invoice where docnumber = '1001'",
  "select * from Invoice where DocNumber = '1001' ORDERBY Id",
]) {
  show(q, await qbo.query(q), (b) => (b.QueryResponse ? { ids: ids(b, 'Invoice') } : b))
}
