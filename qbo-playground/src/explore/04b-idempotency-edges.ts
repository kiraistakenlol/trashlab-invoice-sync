// Area 4 follow-up: concurrent requests with one key, whether a failed request's key is
// remembered, key length limits, and replaying a key after the record changed or was
// deleted. Optional args `<key> <displayName>` replay an earlier customer create (to see
// how long keys are remembered).
import { randomUUID } from 'node:crypto'
import { client } from '../setup.js'
import { marker, show } from './lib.js'

const qbo = client()
const m = marker('04b')
const err = (b: any) => b.Fault?.Error?.map((e: any) => `${e.code} ${e.Message} | ${e.Detail}`)
const line = {
  Amount: 10,
  DetailType: 'SalesItemLineDetail',
  SalesItemLineDetail: { ItemRef: { value: '1' } },
}
const brief = (b: any) =>
  err(b) ?? {
    Id: b.Invoice?.Id ?? b.Customer?.Id,
    SyncToken: b.Invoice?.SyncToken,
    PrivateNote: b.Invoice?.PrivateNote,
    time: b.time,
  }
const countDoc = async (doc: string) =>
  (
    (await qbo.query(`select Id from Invoice where DocNumber = '${doc}'`)).body as any
  ).QueryResponse?.Invoice?.map((i: any) => i.Id) ?? []

const [oldKey, oldName] = process.argv.slice(2)
if (oldKey) {
  const res = await qbo.request('POST', '/customer', {
    body: { DisplayName: oldName },
    requestId: oldKey,
  })
  show(
    `replay of an earlier customer create (key ${oldKey})`,
    res,
    (b) => err(b) ?? { Id: b.Customer.Id, time: b.time }
  )
  process.exit(0)
}

const cust = (
  (await qbo.request('POST', '/customer', { body: { DisplayName: `${m}-cust` } })).body as any
).Customer

// Five concurrent creates with one key
const rConc = randomUUID()
const concBody = { CustomerRef: { value: cust.Id }, DocNumber: 'I04b-conc', Line: [line] }
const results = await Promise.all(
  [1, 2, 3, 4, 5].map(() => qbo.request('POST', '/invoice', { body: concBody, requestId: rConc }))
)
results.forEach((r, i) => show(`concurrent create #${i + 1}, one key`, r, brief))
console.log('invoices with DocNumber I04b-conc:', await countDoc('I04b-conc'))

// A failed request, then a valid body with the same key
const rFail = randomUUID()
let res = await qbo.request('POST', '/invoice', {
  body: { CustomerRef: { value: '999999' }, DocNumber: 'I04b-fail', Line: [line] },
  requestId: rFail,
})
show('create with a bad CustomerRef, key F', res, brief)
res = await qbo.request('POST', '/invoice', {
  body: { CustomerRef: { value: cust.Id }, DocNumber: 'I04b-fail', Line: [line] },
  requestId: rFail,
})
show('create with a valid body, key F again', res, brief)

// Key lengths
for (const len of [36, 50, 51, 100, 300]) {
  const key = 'k'.repeat(len - 13) + Date.now()
  res = await qbo.request('POST', '/invoice', {
    body: { CustomerRef: { value: cust.Id }, DocNumber: `I04b-len${len}`, Line: [line] },
    requestId: key,
  })
  show(`create with a ${len}-char key`, res, brief)
  if (res.status === 200) {
    res = await qbo.request('POST', '/invoice', {
      body: { CustomerRef: { value: cust.Id }, DocNumber: `I04b-len${len}`, Line: [line] },
      requestId: key,
    })
    console.log(
      `  replay -> status ${res.status}; invoices with I04b-len${len}:`,
      await countDoc(`I04b-len${len}`)
    )
  }
}

// Replay a create after the record was updated, then after it was deleted
const rChg = randomUUID()
const chgBody = { CustomerRef: { value: cust.Id }, DocNumber: 'I04b-chg', Line: [line] }
const created = (
  (await qbo.request('POST', '/invoice', { body: chgBody, requestId: rChg })).body as any
).Invoice
const updated = (
  (
    await qbo.request('POST', '/invoice', {
      body: {
        Id: created.Id,
        SyncToken: created.SyncToken,
        sparse: true,
        PrivateNote: `${m}-changed`,
      },
    })
  ).body as any
).Invoice
res = await qbo.request('POST', '/invoice', { body: chgBody, requestId: rChg })
show('replay create after an update (current SyncToken 1)', res, brief)
await qbo.request('POST', '/invoice', {
  query: { operation: 'delete' },
  body: { Id: updated.Id, SyncToken: updated.SyncToken },
})
res = await qbo.request('POST', '/invoice', { body: chgBody, requestId: rChg })
show('replay create after the invoice was deleted', res, brief)
console.log('invoices with DocNumber I04b-chg:', await countDoc('I04b-chg'))
