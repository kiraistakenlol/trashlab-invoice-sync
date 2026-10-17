// Area 4: the `requestid` query parameter as an idempotency key. Replays of creates,
// updates, deletes and payments; same key with a different body or endpoint; a create
// aborted by a client timeout and then retried; creates without a key.
import { randomUUID } from 'node:crypto'
import { client } from '../setup.js'
import { marker, show } from './lib.js'

const qbo = client()
const m = marker('04')
const err = (b: any) => b.Fault?.Error?.map((e: any) => `${e.code} ${e.Message} | ${e.Detail}`)
const line = (amount: number) => ({
  Amount: amount,
  DetailType: 'SalesItemLineDetail',
  SalesItemLineDetail: { ItemRef: { value: '1' } },
})
const inv = (b: any) =>
  err(b) ?? {
    Id: b.Invoice?.Id,
    SyncToken: b.Invoice?.SyncToken,
    TotalAmt: b.Invoice?.TotalAmt,
    DocNumber: b.Invoice?.DocNumber,
    PrivateNote: b.Invoice?.PrivateNote,
    time: b.time,
  }
const rid = () => randomUUID()
const countDoc = async (doc: string) =>
  (
    (await qbo.query(`select Id from Invoice where DocNumber = '${doc}'`)).body as any
  ).QueryResponse?.Invoice?.map((i: any) => i.Id) ?? []

// Customer create replay
const rCust = rid()
const custBody = { DisplayName: `${m}-cust` }
let res = await qbo.request('POST', '/customer', { body: custBody, requestId: rCust })
show('customer create, key A', res, (b) => err(b) ?? { Id: b.Customer.Id, time: b.time })
const cust = (res.body as any).Customer
res = await qbo.request('POST', '/customer', { body: custBody, requestId: rCust })
show(
  'customer create replay, key A, same body',
  res,
  (b) => err(b) ?? { Id: b.Customer.Id, time: b.time }
)
res = await qbo.request('POST', '/customer', { body: custBody })
show('customer create, same body, no key (duplicate name)', res, err)

// Invoice create replay
const rInv = rid()
const invBody = { CustomerRef: { value: cust.Id }, DocNumber: 'I04-a', Line: [line(10)] }
res = await qbo.request('POST', '/invoice', { body: invBody, requestId: rInv })
show('invoice create, key B', res, inv)
const first = (res.body as any).Invoice
res = await qbo.request('POST', '/invoice', { body: invBody, requestId: rInv })
show('invoice create replay, key B, same body', res, inv)
console.log(
  'identical bodies:',
  JSON.stringify(res.body) === JSON.stringify({ Invoice: first, time: (res.body as any).time })
)
res = await qbo.request('POST', '/invoice', {
  body: { ...invBody, DocNumber: 'I04-b', Line: [line(99)] },
  requestId: rInv,
})
show('invoice create, key B, different body', res, inv)
res = await qbo.request('POST', '/customer', {
  body: { DisplayName: `${m}-other` },
  requestId: rInv,
})
show(
  'customer create, key B (used for an invoice)',
  res,
  (b) => err(b) ?? { Customer: { Id: b.Customer?.Id, DisplayName: b.Customer?.DisplayName } }
)
console.log(
  'invoices with DocNumber I04-a:',
  await countDoc('I04-a'),
  ' I04-b:',
  await countDoc('I04-b')
)

// Update replay: the second send carries a token that is stale by then
const rUpd = rid()
const updBody = { Id: first.Id, SyncToken: first.SyncToken, sparse: true, PrivateNote: `${m}-upd1` }
res = await qbo.request('POST', '/invoice', { body: updBody, requestId: rUpd })
show('sparse update, key C', res, inv)
res = await qbo.request('POST', '/invoice', { body: updBody, requestId: rUpd })
show('sparse update replay, key C (token now stale)', res, inv)
res = await qbo.request('POST', '/invoice', { body: updBody })
show('same update, no key', res, inv)
res = await qbo.request('GET', `/invoice/${first.Id}`)
show('invoice after updates', res, inv)

// Payment create replay
const rPay = rid()
const payBody = {
  CustomerRef: { value: cust.Id },
  TotalAmt: 4,
  Line: [{ Amount: 4, LinkedTxn: [{ TxnId: first.Id, TxnType: 'Invoice' }] }],
}
res = await qbo.request('POST', '/payment', { body: payBody, requestId: rPay })
show('payment create, key D', res, (b) => err(b) ?? { Id: b.Payment.Id })
res = await qbo.request('POST', '/payment', { body: payBody, requestId: rPay })
show('payment create replay, key D', res, (b) => err(b) ?? { Id: b.Payment.Id })
res = await qbo.request('GET', `/invoice/${first.Id}`)
show('invoice balance after payment replay', res, (b) => ({
  TotalAmt: b.Invoice.TotalAmt,
  Balance: b.Invoice.Balance,
  LinkedTxn: b.Invoice.LinkedTxn,
}))

// Delete replay (on a fresh invoice)
const victim = (
  (
    await qbo.request('POST', '/invoice', {
      body: { CustomerRef: { value: cust.Id }, DocNumber: 'I04-del', Line: [line(5)] },
    })
  ).body as any
).Invoice
const rDel = rid()
const delBody = { Id: victim.Id, SyncToken: victim.SyncToken }
res = await qbo.request('POST', '/invoice', {
  query: { operation: 'delete' },
  body: delBody,
  requestId: rDel,
})
show('delete, key E', res)
res = await qbo.request('POST', '/invoice', {
  query: { operation: 'delete' },
  body: delBody,
  requestId: rDel,
})
show('delete replay, key E', res)
res = await qbo.request('POST', '/invoice', { query: { operation: 'delete' }, body: delBody })
show('delete again, no key', res, err)

// Timeout after write: abort the client early, then retry with the same key
const rTo = rid()
const toBody = { CustomerRef: { value: cust.Id }, DocNumber: 'I04-to', Line: [line(7)] }
for (const timeoutMs of [1, 50, 150, 300]) {
  try {
    res = await qbo.request('POST', '/invoice', { body: toBody, requestId: rTo, timeoutMs })
    show(`create with timeoutMs=${timeoutMs} completed`, res, inv)
    break
  } catch (e: any) {
    console.log(`\n=== create with timeoutMs=${timeoutMs}: client aborted (${e.name})`)
  }
}
await new Promise((r) => setTimeout(r, 3000))
console.log('invoices with DocNumber I04-to before retry:', await countDoc('I04-to'))
res = await qbo.request('POST', '/invoice', { body: toBody, requestId: rTo })
show('retry with the same key', res, inv)
console.log('invoices with DocNumber I04-to after retry:', await countDoc('I04-to'))

// No key: a retried create duplicates
const plain = { CustomerRef: { value: cust.Id }, DocNumber: 'I04-nokey', Line: [line(3)] }
await qbo.request('POST', '/invoice', { body: plain })
await qbo.request('POST', '/invoice', { body: plain })
console.log(
  '\ninvoices with DocNumber I04-nokey after two keyless creates:',
  await countDoc('I04-nokey')
)

console.log(
  '\nkeys for later replay:',
  JSON.stringify({ customer: rCust, invoice: rInv, body: custBody, at: new Date().toISOString() })
)
