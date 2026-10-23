// Area 12: finding pre-existing records without a stored link, and where an external id
// can be kept on a QBO invoice. Which invoice / customer fields are filterable in queries;
// custom fields in this company; whether PrivateNote / CustomField can carry and find an id.
import { client } from '../setup.js'
import { marker, show } from './lib.js'

const qbo = client()
const m = marker('12')
const err = (b: any) => b.Fault?.Error?.map((e: any) => `${e.code} ${e.Message} | ${e.Detail}`)
const ids = (entity: string) => (b: any) =>
  err(b) ?? b.QueryResponse?.[entity]?.map((x: any) => x.Id) ?? []
const line = {
  Amount: 42.5,
  DetailType: 'SalesItemLineDetail',
  SalesItemLineDetail: { ItemRef: { value: '1' } },
}

// Custom field setup in this company
const prefs = ((await qbo.request('GET', '/preferences')).body as any).Preferences
show('SalesFormsPrefs.CustomField', {
  status: 200,
  intuitTid: null,
  headers: {},
  body: prefs.SalesFormsPrefs?.CustomField ?? null,
})

// A record to match against
const cust = (
  (
    await qbo.request('POST', '/customer', {
      body: {
        DisplayName: `${m}-Cust`,
        CompanyName: `${m} Co`,
        PrimaryEmailAddr: { Address: 'match@example.com' },
      },
    })
  ).body as any
).Customer
const extId = `ext-${Date.now()}`
const res = await qbo.request('POST', '/invoice', {
  body: {
    CustomerRef: { value: cust.Id },
    DocNumber: 'M12-0001',
    TxnDate: '2026-10-01',
    PrivateNote: `ext:${extId}`,
    CustomField: [{ DefinitionId: '1', Type: 'StringType', StringValue: extId }],
    Line: [line],
  },
})
show(
  'invoice with PrivateNote + CustomField 1',
  res,
  (b) =>
    err(b) ?? {
      Id: b.Invoice.Id,
      CustomField: b.Invoice.CustomField,
      PrivateNote: b.Invoice.PrivateNote,
    }
)
const inv = (res.body as any).Invoice

// Invoice filters
for (const [label, where] of [
  ['DocNumber =', `DocNumber = 'M12-0001'`],
  ['DocNumber lower-case', `DocNumber = 'm12-0001'`],
  ['DocNumber LIKE', `DocNumber LIKE 'M12-%'`],
  ['CustomerRef =', `CustomerRef = '${cust.Id}'`],
  ['TxnDate =', `TxnDate = '2026-10-01'`],
  ['TotalAmt =', `TotalAmt = '42.5'`],
  [
    'CustomerRef + TotalAmt + TxnDate',
    `CustomerRef = '${cust.Id}' AND TotalAmt = '42.50' AND TxnDate = '2026-10-01'`,
  ],
  ['PrivateNote =', `PrivateNote = 'ext:${extId}'`],
  ['PrivateNote LIKE', `PrivateNote LIKE 'ext:%'`],
  ['CustomField', `CustomField = '${extId}'`],
  ['Balance >', `CustomerRef = '${cust.Id}' AND Balance > '0'`],
  ['DueDate', `DueDate = '${inv.DueDate}'`],
  ['CustomerMemo', `CustomerMemo = 'x'`],
] as const) {
  show(
    `Invoice where ${label}`,
    await qbo.query(`select Id from Invoice where ${where}`),
    ids('Invoice')
  )
}

// Customer filters
for (const [label, where] of [
  ['DisplayName =', `DisplayName = '${m}-Cust'`],
  ['DisplayName lower-case', `DisplayName = '${m.toLowerCase()}-cust'`],
  ['DisplayName LIKE', `DisplayName LIKE '${m}%'`],
  ['CompanyName =', `CompanyName = '${m} Co'`],
  ['PrimaryEmailAddr =', `PrimaryEmailAddr = 'match@example.com'`],
  ['GivenName', `GivenName = 'x'`],
] as const) {
  show(
    `Customer where ${label}`,
    await qbo.query(`select Id from Customer where ${where}`),
    ids('Customer')
  )
}

// Name with an apostrophe: escaping in queries
const odd = (
  (await qbo.request('POST', '/customer', { body: { DisplayName: `${m} O'Brien` } })).body as any
).Customer
show('customer with an apostrophe created', {
  status: 200,
  intuitTid: null,
  headers: {},
  body: odd?.DisplayName ?? null,
})
show(
  "query with \\' escape",
  await qbo.query(`select Id from Customer where DisplayName = '${m} O\\'Brien'`),
  ids('Customer')
)
show(
  "query with '' escape",
  await qbo.query(`select Id from Customer where DisplayName = '${m} O''Brien'`),
  ids('Customer')
)
