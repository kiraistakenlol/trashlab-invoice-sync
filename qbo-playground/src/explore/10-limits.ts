// Area 10: limits and failure modes. Refresh-token rotation and whether old tokens keep
// working (prints only booleans and lifetimes, never token values; always saves the newest
// valid tokens); concurrent requests and a burst to provoke throttling; the /batch endpoint
// with a partial failure and its size limit.
import { createQboClient, refreshTokens, type StoredTokens } from '../../../src/qbo/index.js'
import { client, tokenStore, oauthConfig } from '../setup.js'
import { marker, show } from './lib.js'

const m = marker('10')
const oauth = oauthConfig()
const err = (b: any) => b?.Fault?.Error?.map((e: any) => `${e.code} ${e.Message} | ${e.Detail}`)
const mins = (d: Date) => Math.round((d.getTime() - Date.now()) / 60000)
const withTokens = (t: StoredTokens) =>
  createQboClient({
    oauth,
    environment: 'sandbox',
    tokenStore: { load: async () => t, save: async () => {} },
  })

// --- Tokens
const t0 = (await tokenStore.load())!
console.log(
  `\n=== stored tokens: access expires in ${mins(t0.accessTokenExpiresAt)} min, refresh in ${Math.round(mins(t0.refreshTokenExpiresAt) / 1440)} days`
)
const r1 = await refreshTokens(oauth, t0.refreshToken)
await tokenStore.save({ realmId: t0.realmId, ...r1 })
console.log(
  `refresh #1: new access token ${r1.accessToken !== t0.accessToken}, new refresh token ${r1.refreshToken !== t0.refreshToken}, access lifetime ${mins(r1.accessTokenExpiresAt)} min, refresh lifetime ${Math.round(mins(r1.refreshTokenExpiresAt) / 1440)} days`
)
const r2 = await refreshTokens(oauth, r1.refreshToken)
await tokenStore.save({ realmId: t0.realmId, ...r2 })
console.log(
  `refresh #2 (immediately): new access token ${r2.accessToken !== r1.accessToken}, new refresh token ${r2.refreshToken !== r1.refreshToken}`
)
try {
  const r0 = await refreshTokens(oauth, t0.refreshToken)
  await tokenStore.save({ realmId: t0.realmId, ...r0 })
  console.log(
    `refresh with the ORIGINAL refresh token: accepted; returns the same refresh token as #2: ${r0.refreshToken === r2.refreshToken}`
  )
} catch (e: any) {
  console.log(
    `refresh with the ORIGINAL refresh token: rejected - ${e.message.replace(/"access_token":"[^"]*"/g, '')}`
  )
}
try {
  await refreshTokens(oauth, 'not-a-token')
} catch (e: any) {
  console.log(`refresh with garbage: rejected - ${e.message}`)
}
for (const [label, t] of [
  ['original access token', t0],
  ['access token #1', r1],
] as const) {
  const res = await withTokens({
    realmId: t0.realmId,
    ...t,
    accessTokenExpiresAt: new Date(Date.now() + 3600_000),
  }).request('GET', `/companyinfo/${t0.realmId}`)
  console.log(`${label} after later refreshes: HTTP ${res.status}`)
}

const qbo = client()

// --- Concurrency: 30 parallel reads
let t = Date.now()
const rs = await Promise.all(
  Array.from({ length: 30 }, () => qbo.query('select count(*) from Invoice'))
)
const tally = (list: { status: number }[]) =>
  Object.entries(
    list.reduce<Record<number, number>>(
      (a, r) => ({ ...a, [r.status]: (a[r.status] ?? 0) + 1 }),
      {}
    )
  )
console.log(`\n=== 30 parallel queries in ${Date.now() - t} ms:`, JSON.stringify(tally(rs)))
const throttled = rs.find((r) => r.status === 429)
if (throttled) {
  show('a throttled response (headers + body)', throttled, (b) => ({
    body: b,
    headers: throttled.headers,
  }))
}

// --- Burst: up to 600 reads, 10 at a time, stop at the first 429
t = Date.now()
const all: { status: number; at: number; res: any }[] = []
let stop = false
for (let i = 0; i < 60 && !stop; i++) {
  const batch = await Promise.all(
    Array.from({ length: 10 }, () => qbo.request('GET', `/companyinfo/${t0.realmId}`))
  )
  for (const r of batch) {
    all.push({ status: r.status, at: Date.now() - t, res: r })
  }
  stop = batch.some((r) => r.status === 429)
}
console.log(
  `\n=== burst: ${all.length} requests in ${Date.now() - t} ms:`,
  JSON.stringify(tally(all))
)
const first429 = all.find((r) => r.status === 429)
if (first429) {
  console.log(`first 429 after ${all.indexOf(first429)} requests, at ${first429.at} ms`)
  show('429 headers + body', first429.res, (b) => ({ body: b, headers: first429.res.headers }))
  const wait = Date.now()
  let r
  do {
    r = await qbo.request('GET', `/companyinfo/${t0.realmId}`)
  } while (
    r.status === 429 &&
    Date.now() - wait < 90_000 &&
    (await new Promise((ok) => setTimeout(ok, 2000)), true)
  )
  console.log(`recovered after ~${Date.now() - wait} ms (status ${r.status})`)
}

// --- /batch: one valid create, one invalid create, one query
let res = await qbo.request('POST', '/batch', {
  body: {
    BatchItemRequest: [
      { bId: 'ok', operation: 'create', Customer: { DisplayName: `${m}-batch` } },
      {
        bId: 'bad',
        operation: 'create',
        Invoice: {
          CustomerRef: { value: '999999' },
          Line: [
            {
              Amount: 1,
              DetailType: 'SalesItemLineDetail',
              SalesItemLineDetail: { ItemRef: { value: '1' } },
            },
          ],
        },
      },
      { bId: 'q', Query: 'select count(*) from Customer' },
    ],
  },
})
show(
  '/batch: create ok + create invalid + query',
  res,
  (b) =>
    err(b) ??
    b.BatchItemResponse.map((x: any) => ({
      bId: x.bId,
      keys: Object.keys(x),
      Customer: x.Customer && { Id: x.Customer.Id },
      Fault: x.Fault && { type: x.Fault.type, errors: err(x) },
      QueryResponse: x.QueryResponse,
    }))
)
res = await qbo.request('POST', '/batch', {
  body: {
    BatchItemRequest: Array.from({ length: 31 }, (_, i) => ({
      bId: `q${i}`,
      Query: 'select count(*) from Item',
    })),
  },
})
show('/batch with 31 items', res, (b) => err(b) ?? `${b.BatchItemResponse.length} responses`)
res = await qbo.request('POST', '/batch', {
  body: {
    BatchItemRequest: Array.from({ length: 30 }, (_, i) => ({
      bId: `q${i}`,
      Query: 'select count(*) from Item',
    })),
  },
})
show('/batch with 30 items', res, (b) => err(b) ?? `${b.BatchItemResponse.length} responses`)
