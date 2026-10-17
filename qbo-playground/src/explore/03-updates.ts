// Area 3: full vs sparse update, line handling on update, SyncToken (stale / missing /
// no-op), duplicate DocNumber, concurrent updates.
import { client } from '../setup.js'
import { marker, show } from './lib.js'

const qbo = client()
const m = marker('03')
const err = (b: any) => b.Fault?.Error?.map((e: any) => `${e.code} ${e.Message} | ${e.Detail}`)
const item = (amount: number, desc: string, id?: string) => ({
  ...(id ? { Id: id } : {}),
  Amount: amount,
  Description: desc,
  DetailType: 'SalesItemLineDetail',
  SalesItemLineDetail: { ItemRef: { value: '1' } },
})
const brief = (i: any) => ({
  SyncToken: i.SyncToken,
  LastUpdatedTime: i.MetaData.LastUpdatedTime,
  DocNumber: i.DocNumber,
  TxnDate: i.TxnDate,
  DueDate: i.DueDate,
  PrivateNote: i.PrivateNote,
  CustomerMemo: i.CustomerMemo?.value,
  BillEmail: i.BillEmail?.Address,
  SalesTermRef: i.SalesTermRef?.value,
  TotalAmt: i.TotalAmt,
  lines: i.Line.filter((l: any) => l.DetailType !== 'SubTotalLineDetail').map(
    (l: any) => `${l.Id}:${l.LineNum}:${l.Description}:${l.Amount}`
  ),
})
const get = async (id: string) => ((await qbo.request('GET', `/invoice/${id}`)).body as any).Invoice
const post = (label: string, body: object, query?: Record<string, string>) =>
  qbo.request('POST', '/invoice', { body, query }).then((res) => {
    show(label, res, (b) => err(b) ?? brief(b.Invoice))
    return res
  })
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

const cust = (
  (await qbo.request('POST', '/customer', { body: { DisplayName: `${m}-cust` } })).body as any
).Customer
const created = (
  await post('create: 3 lines + memo + note + email + DocNumber', {
    CustomerRef: { value: cust.Id },
    DocNumber: `X${Date.now()}`.slice(0, 15),
    PrivateNote: `${m} note`,
    CustomerMemo: { value: 'memo' },
    BillEmail: { Address: 'a@example.com' },
    DueDate: '2026-12-31',
    Line: [item(10, 'A'), item(20, 'B'), item(30, 'C')],
  })
).body as any
let inv = created.Invoice

// --- No-op updates
await pause(1100)
let res = await post('sparse no-op (Id + SyncToken + sparse only)', {
  Id: inv.Id,
  SyncToken: inv.SyncToken,
  sparse: true,
})
inv = (res.body as any).Invoice
await pause(1100)
res = await post('full no-op (send back exactly what GET returned)', await get(inv.Id))
inv = (res.body as any).Invoice

// --- Stale / missing / future SyncToken
await post('stale SyncToken (0)', {
  Id: inv.Id,
  SyncToken: '0',
  sparse: true,
  PrivateNote: 'stale',
})
await post('missing SyncToken', { Id: inv.Id, sparse: true, PrivateNote: 'no token' })
await post('future SyncToken (+5)', {
  Id: inv.Id,
  SyncToken: String(Number(inv.SyncToken) + 5),
  sparse: true,
  PrivateNote: 'future',
})
await post('SyncToken as number', {
  Id: inv.Id,
  SyncToken: Number(inv.SyncToken),
  sparse: true,
  PrivateNote: 'numeric token',
}).then((r) => {
  if (r.status === 200) inv = (r.body as any).Invoice
})

// --- Sparse update semantics
inv = await get(inv.Id)
res = await post('sparse: change PrivateNote only', {
  Id: inv.Id,
  SyncToken: inv.SyncToken,
  sparse: true,
  PrivateNote: `${m} note 2`,
})
inv = (res.body as any).Invoice
res = await post('sparse: PrivateNote "" (clear?)', {
  Id: inv.Id,
  SyncToken: inv.SyncToken,
  sparse: true,
  PrivateNote: '',
})
inv = (res.body as any).Invoice
res = await post('sparse: CustomerMemo null (clear?)', {
  Id: inv.Id,
  SyncToken: inv.SyncToken,
  sparse: true,
  CustomerMemo: null,
})
inv = (res.body as any).Invoice
res = await post('sparse: Line with only line 2 (by Id) changed to 25', {
  Id: inv.Id,
  SyncToken: inv.SyncToken,
  sparse: true,
  Line: [item(25, 'B2', '2')],
})
inv = (res.body as any).Invoice

// --- Full update semantics
inv = await get(inv.Id)
res = await post('full: only Id, SyncToken, CustomerRef, Line (everything else omitted)', {
  Id: inv.Id,
  SyncToken: inv.SyncToken,
  CustomerRef: inv.CustomerRef,
  Line: inv.Line.filter((l: any) => l.DetailType !== 'SubTotalLineDetail'),
})
inv = (res.body as any).Invoice

// --- Lines on update
inv = await get(inv.Id)
const lines = inv.Line.filter((l: any) => l.DetailType !== 'SubTotalLineDetail')
res = await post('full: drop first line, keep others by Id, add new line without Id', {
  ...inv,
  Line: [...lines.slice(1), item(40, 'D')],
})
inv = (res.body as any).Invoice
res = await post('full: re-add a line without Id (Id reuse?)', {
  ...inv,
  Line: [...inv.Line.filter((l: any) => l.DetailType !== 'SubTotalLineDetail'), item(50, 'E')],
})
inv = (res.body as any).Invoice
res = await post('full: line with unknown Id 99', {
  ...inv,
  Line: [
    ...inv.Line.filter((l: any) => l.DetailType !== 'SubTotalLineDetail'),
    item(60, 'F', '99'),
  ],
})
if (res.status === 200) inv = (res.body as any).Invoice
res = await post('full: reorder lines (reverse)', {
  ...inv,
  Line: inv.Line.filter((l: any) => l.DetailType !== 'SubTotalLineDetail').reverse(),
})
if (res.status === 200) inv = (res.body as any).Invoice
res = await post('full: send SubTotal line back too', { ...inv })
if (res.status === 200) inv = (res.body as any).Invoice
res = await post('full: empty Line array', { ...inv, Line: [] })
if (res.status === 200) inv = (res.body as any).Invoice

// --- Change CustomerRef on update
const cust2 = (
  (await qbo.request('POST', '/customer', { body: { DisplayName: `${m}-cust2` } })).body as any
).Customer
inv = await get(inv.Id)
res = await post('sparse: change CustomerRef', {
  Id: inv.Id,
  SyncToken: inv.SyncToken,
  sparse: true,
  CustomerRef: { value: cust2.Id },
})
if (res.status === 200) inv = (res.body as any).Invoice

// --- Duplicate DocNumber
await post('create with an existing DocNumber', {
  CustomerRef: { value: cust.Id },
  DocNumber: inv.DocNumber,
  Line: [item(1, 'dup')],
})
const other = (
  await post('create another invoice', {
    CustomerRef: { value: cust.Id },
    Line: [item(1, 'other')],
  })
).body as any
await post('update: set DocNumber to an existing one', {
  Id: other.Invoice.Id,
  SyncToken: other.Invoice.SyncToken,
  sparse: true,
  DocNumber: inv.DocNumber,
})
await post('update: DocNumber "" (clear?)', {
  Id: other.Invoice.Id,
  SyncToken: (await get(other.Invoice.Id)).SyncToken,
  sparse: true,
  DocNumber: '',
})

// --- Two concurrent updates with the same SyncToken
inv = await get(inv.Id)
const [r1, r2] = await Promise.all([
  qbo.request('POST', '/invoice', {
    body: { Id: inv.Id, SyncToken: inv.SyncToken, sparse: true, PrivateNote: 'racer 1' },
  }),
  qbo.request('POST', '/invoice', {
    body: { Id: inv.Id, SyncToken: inv.SyncToken, sparse: true, PrivateNote: 'racer 2' },
  }),
])
show('concurrent #1', r1, (b) => err(b) ?? brief(b.Invoice))
show('concurrent #2', r2, (b) => err(b) ?? brief(b.Invoice))
show(
  'final state after race',
  { status: 200, intuitTid: null, headers: {}, body: await get(inv.Id) },
  brief
)

// --- Is a write ever partially applied? Valid field + invalid field in one sparse update.
inv = await get(inv.Id)
await post('sparse: valid PrivateNote + invalid ItemRef line', {
  Id: inv.Id,
  SyncToken: inv.SyncToken,
  sparse: true,
  PrivateNote: 'should not stick',
  Line: [{ ...item(5, 'bad'), SalesItemLineDetail: { ItemRef: { value: '99999' } } }],
})
show(
  'after rejected update',
  { status: 200, intuitTid: null, headers: {}, body: await get(inv.Id) },
  brief
)
