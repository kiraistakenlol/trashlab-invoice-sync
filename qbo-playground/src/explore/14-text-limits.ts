// Max length of every free-text field the sync writes: invoice CustomerMemo, line
// Description, customer DisplayName, item Name, account Name. Binary search per field;
// also checks whether QBO stores the value whole or cuts it silently.
import { client } from '../setup.js'
import { marker } from './lib.js'

const qbo = client()
const m = marker('14')
const err = (b: any) => b.Fault?.Error?.map((e: any) => `${e.code} ${e.Message} | ${e.Detail}`)

const cust = (
  (await qbo.request('POST', '/customer', { body: { DisplayName: `${m}-cust` } })).body as any
).Customer
const account = (
  (await qbo.query("select * from Account where AccountType = 'Income' maxresults 1")).body as any
).QueryResponse.Account[0]

const line = (description?: string) => ({
  Amount: 10,
  DetailType: 'SalesItemLineDetail',
  SalesItemLineDetail: { ItemRef: { value: '1' } },
  ...(description !== undefined && { Description: description }),
})

let n = 0
const unique = (len: number) => `${n++}-${m}-`.padEnd(len, 'x').slice(0, len)

// Each probe creates a record with a value of `len` chars and returns the stored value
const probes: Record<string, { create: (len: number) => [string, unknown]; stored: (b: any) => string }> = {
  'Invoice.CustomerMemo': {
    create: (len) => ['/invoice', { CustomerRef: { value: cust.Id }, CustomerMemo: { value: 'm'.repeat(len) }, Line: [line()] }],
    stored: (b) => b.Invoice.CustomerMemo?.value ?? '',
  },
  'Invoice.Line.Description': {
    create: (len) => ['/invoice', { CustomerRef: { value: cust.Id }, Line: [line('d'.repeat(len))] }],
    stored: (b) => b.Invoice.Line[0].Description ?? '',
  },
  'Customer.DisplayName': {
    create: (len) => ['/customer', { DisplayName: unique(len) }],
    stored: (b) => b.Customer.DisplayName,
  },
  'Item.Name': {
    create: (len) => ['/item', { Name: unique(len), Type: 'Service', IncomeAccountRef: { value: account.Id } }],
    stored: (b) => b.Item.Name,
  },
  'Account.Name': {
    create: (len) => ['/account', { Name: unique(len), AccountType: 'Income' }],
    stored: (b) => b.Account.Name,
  },
}

for (const [field, p] of Object.entries(probes)) {
  let ok = 1
  let bad = 8192
  let lastError: unknown
  let cut: string | undefined
  while (bad - ok > 1) {
    const len = Math.floor((ok + bad) / 2)
    const [path, body] = p.create(len)
    const res = await qbo.request('POST', path, { body })
    if (res.status === 200) {
      ok = len
      const got = p.stored(res.body).length
      if (got !== len) cut = `sent ${len}, stored ${got}`
    } else {
      bad = len
      lastError = err(res.body as any)
    }
  }
  console.log(`\n=== ${field}: max ${ok} chars${bad === 8192 ? ' (no limit found up to 8191)' : ''}`)
  if (cut) console.log(`silently cut: ${cut}`)
  if (lastError) console.log(`error at ${ok + 1}:`, lastError)
}
