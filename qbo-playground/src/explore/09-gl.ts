// Area 9: accounts, items and the general ledger. The chart of accounts; creating and
// deactivating an account; an item on a new income account and the postings an invoice and
// a payment make (GeneralLedger / TrialBalance reports); JournalEntry create, validation,
// update, delete; whether these show up in CDC.
import { client } from '../setup.js'
import { marker, show } from './lib.js'

const qbo = client()
const m = marker('09')
const today = new Date().toISOString().slice(0, 10)
const startedAt = new Date(Date.now() - 2000).toISOString()
const err = (b: any) => b.Fault?.Error?.map((e: any) => `${e.code} ${e.Message} | ${e.Detail}`)
const post = (path: string, body: unknown, query?: Record<string, string>) =>
  qbo.request('POST', path, { body, query })
const acct = (b: any) =>
  err(b) ??
  (b.Account && {
    Id: b.Account.Id,
    SyncToken: b.Account.SyncToken,
    Name: b.Account.Name,
    FullyQualifiedName: b.Account.FullyQualifiedName,
    AccountType: b.Account.AccountType,
    AccountSubType: b.Account.AccountSubType,
    Classification: b.Account.Classification,
    Active: b.Account.Active,
    CurrentBalance: b.Account.CurrentBalance,
  })
const je = (b: any) =>
  err(b) ??
  (b.JournalEntry && {
    Id: b.JournalEntry.Id,
    SyncToken: b.JournalEntry.SyncToken,
    TotalAmt: b.JournalEntry.TotalAmt,
    DocNumber: b.JournalEntry.DocNumber,
    Line: b.JournalEntry.Line?.map(
      (l: any) =>
        `${l.Id}:${l.JournalEntryLineDetail?.PostingType}:${l.Amount}:${l.JournalEntryLineDetail?.AccountRef?.name}${l.JournalEntryLineDetail?.Entity ? ':' + l.JournalEntryLineDetail.Entity.Type + ' ' + l.JournalEntryLineDetail.Entity.EntityRef?.value : ''}`
    ),
  })

// Chart of accounts
let res = await qbo.query('select * from Account maxresults 1000')
const accounts: any[] = (res.body as any).QueryResponse.Account
const byType: Record<string, string[]> = {}
for (const a of accounts)
  (byType[`${a.Classification} / ${a.AccountType}`] ??= []).push(`${a.Id}:${a.Name}`)
console.log('\n=== chart of accounts by Classification / AccountType')
for (const [k, v] of Object.entries(byType).sort())
  console.log(`${k} (${v.length}): ${v.slice(0, 6).join(', ')}${v.length > 6 ? ', ...' : ''}`)
show('one account, full', {
  status: 200,
  intuitTid: res.intuitTid,
  headers: {},
  body: accounts.find((a) => a.Id === '84'),
})

// Items and their accounts
res = await qbo.query('select * from Item maxresults 1000')
console.log('\n=== items: Id:Name:Type -> income / expense / asset account')
for (const i of (res.body as any).QueryResponse.Item)
  console.log(
    `${i.Id}:${i.Name}:${i.Type} -> ${i.IncomeAccountRef?.name ?? '-'} / ${i.ExpenseAccountRef?.name ?? '-'} / ${i.AssetAccountRef?.name ?? '-'}`
  )

// Account create, duplicate, invalid type, deactivate, delete
res = await post('/account', { Name: `${m}-income`, AccountType: 'Income' })
show('account create (Name + AccountType Income)', res, acct)
const income = (res.body as any).Account
show(
  'account create, same name',
  await post('/account', { Name: `${m}-income`, AccountType: 'Income' }),
  acct
)
show(
  'account create, name with a colon',
  await post('/account', { Name: `${m}:x`, AccountType: 'Income' }),
  acct
)
show(
  'account create, unknown AccountType',
  await post('/account', { Name: `${m}-bogus`, AccountType: 'Bogus' }),
  acct
)
show('account create, no AccountType', await post('/account', { Name: `${m}-notype` }), acct)
const spare = (await post('/account', { Name: `${m}-spare`, AccountType: 'Expense' })).body as any
show(
  'account ?operation=delete',
  await post(
    '/account',
    { Id: spare.Account.Id, SyncToken: spare.Account.SyncToken },
    { operation: 'delete' }
  ),
  acct
)
res = await post('/account', {
  Id: spare.Account.Id,
  SyncToken: spare.Account.SyncToken,
  sparse: true,
  Name: spare.Account.Name,
  Active: false,
})
show('account deactivate (sparse Active false)', res, acct)

// Item on the new income account; an invoice and a payment; the postings
res = await post('/item', {
  Name: `${m}-svc`,
  Type: 'Service',
  IncomeAccountRef: { value: income.Id },
})
show(
  'service item on the new account',
  res,
  (b) => err(b) ?? { Id: b.Item.Id, Name: b.Item.Name, IncomeAccountRef: b.Item.IncomeAccountRef }
)
const item = (res.body as any).Item
const cust = ((await post('/customer', { DisplayName: `${m}-cust` })).body as any).Customer
const inv = (
  (
    await post('/invoice', {
      CustomerRef: { value: cust.Id },
      DocNumber: 'I09',
      Line: [
        {
          Amount: 123.45,
          DetailType: 'SalesItemLineDetail',
          SalesItemLineDetail: { ItemRef: { value: item.Id } },
        },
      ],
    })
  ).body as any
).Invoice
console.log(
  `\ninvoice ${inv.Id}: line ItemAccountRef =`,
  JSON.stringify(inv.Line[0].SalesItemLineDetail.ItemAccountRef)
)
await post('/payment', {
  CustomerRef: { value: cust.Id },
  TotalAmt: 23.45,
  Line: [{ Amount: 23.45, LinkedTxn: [{ TxnId: inv.Id, TxnType: 'Invoice' }] }],
})
show(
  'the income account after invoice + payment',
  await qbo.request('GET', `/account/${income.Id}`),
  acct
)

const gl = await qbo.request('GET', '/reports/GeneralLedger', {
  query: { start_date: today, end_date: today, account: `${income.Id},84,4` },
})
const flat = (rows: any[], depth = 0): string[] =>
  rows.flatMap((r) => [
    ...(r.Header
      ? [`${'  '.repeat(depth)}[H] ${r.Header.ColData.map((c: any) => c.value).join(' | ')}`]
      : []),
    ...(r.ColData
      ? [`${'  '.repeat(depth)}${r.ColData.map((c: any) => c.value).join(' | ')}`]
      : []),
    ...(r.Rows?.Row ? flat(r.Rows.Row, depth + 1) : []),
    ...(r.Summary
      ? [`${'  '.repeat(depth)}[S] ${r.Summary.ColData.map((c: any) => c.value).join(' | ')}`]
      : []),
  ])
const g = gl.body as any
show(
  'GeneralLedger report: header and columns',
  gl,
  (b) =>
    err(b) ?? {
      Header: b.Header,
      Columns: b.Columns.Column.map((c: any) => c.ColTitle || c.ColType),
    }
)
console.log(
  flat(g.Rows?.Row ?? [])
    .filter(
      (l) => l.includes('I09') || l.startsWith('[H]') || l.includes('[S]') || l.includes(`${m}`)
    )
    .join('\n')
)

const tb = await qbo.request('GET', '/reports/TrialBalance', {
  query: { start_date: today, end_date: today },
})
show(
  'TrialBalance: header',
  tb,
  (b) =>
    err(b) ?? {
      Header: b.Header,
      Columns: b.Columns.Column.map((c: any) => c.ColTitle || c.ColType),
      rows: b.Rows?.Row?.length,
    }
)
console.log(
  flat((tb.body as any).Rows?.Row ?? [])
    .filter(
      (l) =>
        l.includes(m) ||
        l.includes('Receivable') ||
        l.includes('Undeposited') ||
        l.includes('TOTAL')
    )
    .join('\n')
)

// JournalEntry
const jl = (type: 'Debit' | 'Credit', amount: number, account: string, extra: object = {}) => ({
  Amount: amount,
  DetailType: 'JournalEntryLineDetail',
  JournalEntryLineDetail: { PostingType: type, AccountRef: { value: account }, ...extra },
})
show(
  'JE unbalanced (debit 10, credit 9)',
  await post('/journalentry', { Line: [jl('Debit', 10, '4'), jl('Credit', 9, income.Id)] }),
  je
)
show('JE one line', await post('/journalentry', { Line: [jl('Debit', 10, '4')] }), je)
show(
  'JE line on A/R without a customer',
  await post('/journalentry', { Line: [jl('Debit', 10, '84'), jl('Credit', 10, income.Id)] }),
  je
)
res = await post('/journalentry', {
  DocNumber: 'JE09',
  PrivateNote: `${m}-je`,
  Line: [
    jl('Debit', 10, '84', { Entity: { Type: 'Customer', EntityRef: { value: cust.Id } } }),
    jl('Credit', 10, income.Id),
  ],
})
show('JE balanced, A/R line with a customer', res, je)
let j = (res.body as any).JournalEntry
show('JE full body', res, (b) => b.JournalEntry)
res = await post('/journalentry', {
  Id: j.Id,
  SyncToken: j.SyncToken,
  sparse: true,
  Line: [
    {
      ...jl('Debit', 15, '84', { Entity: { Type: 'Customer', EntityRef: { value: cust.Id } } }),
      Id: j.Line[0].Id,
    },
    { ...jl('Credit', 15, income.Id), Id: j.Line[1].Id },
  ],
})
show('JE sparse update to 15 / 15', res, je)
j = (res.body as any).JournalEntry ?? j
show(
  'JE sparse update unbalancing it (debit 20)',
  await post('/journalentry', {
    Id: j.Id,
    SyncToken: j.SyncToken,
    sparse: true,
    Line: [
      {
        ...jl('Debit', 20, '84', { Entity: { Type: 'Customer', EntityRef: { value: cust.Id } } }),
        Id: j.Line[0].Id,
      },
      { ...jl('Credit', 15, income.Id), Id: j.Line[1].Id },
    ],
  }),
  je
)
show(
  'customer balance after the A/R journal line',
  await qbo.request('GET', `/customer/${cust.Id}`),
  (b) => ({ Balance: b.Customer.Balance })
)
show(
  'JE ?operation=void',
  await post('/journalentry', { Id: j.Id, SyncToken: j.SyncToken }, { operation: 'void' }),
  je
)
const jj = ((await qbo.request('GET', `/journalentry/${j.Id}`)).body as any).JournalEntry
show(
  'JE ?operation=delete',
  await post('/journalentry', { Id: jj.Id, SyncToken: jj.SyncToken }, { operation: 'delete' })
)

// CDC for these entities
const cdc = await qbo.request('GET', '/cdc', {
  query: { entities: 'Account,Item,JournalEntry', changedSince: startedAt },
})
show(
  'CDC Account,Item,JournalEntry since script start',
  cdc,
  (b) =>
    err(b) ??
    b.CDCResponse[0].QueryResponse.map((q: any) =>
      Object.fromEntries(
        Object.entries(q)
          .filter(([k]) => /^[A-Z]/.test(k))
          .map(([k, v]: any) => [
            k,
            v.map(
              (x: any) => `${x.Id}${x.status ? ' ' + x.status : ''}${x.Name ? ' ' + x.Name : ''}`
            ),
          ])
      )
    )
)
