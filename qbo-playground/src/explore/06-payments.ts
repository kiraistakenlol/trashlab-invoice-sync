// Area 6: payments and invoice balances, one fresh customer per scenario (unapplied
// credit auto-applies to a customer's invoices, see area 5). Full / partial / repeated
// payments, overpayment, one payment over two invoices, editing a payment, invalid
// applications, and changing the customer of a paid invoice.
import { client } from '../setup.js'
import { marker, show } from './lib.js'

const qbo = client()
const m = marker('06')
const err = (b: any) => b.Fault?.Error?.map((e: any) => `${e.code} ${e.Message} | ${e.Detail}`)
const line = (amount: number) => ({
  Amount: amount,
  DetailType: 'SalesItemLineDetail',
  SalesItemLineDetail: { ItemRef: { value: '1' } },
})
const inv = (b: any) =>
  err(b) ??
  (b.Invoice && {
    Id: b.Invoice.Id,
    SyncToken: b.Invoice.SyncToken,
    CustomerRef: b.Invoice.CustomerRef?.value,
    TotalAmt: b.Invoice.TotalAmt,
    Balance: b.Invoice.Balance,
    LinkedTxn: b.Invoice.LinkedTxn,
    keys: Object.keys(b.Invoice).filter((k) => /status|paid/i.test(k)),
  })
const pay = (b: any) =>
  err(b) ??
  (b.Payment && {
    Id: b.Payment.Id,
    SyncToken: b.Payment.SyncToken,
    CustomerRef: b.Payment.CustomerRef?.value,
    TotalAmt: b.Payment.TotalAmt,
    UnappliedAmt: b.Payment.UnappliedAmt,
    Line: b.Payment.Line?.map(
      (l: any) =>
        `${l.Amount}->${l.LinkedTxn?.map((t: any) => `${t.TxnType}:${t.TxnId}`).join(',')}`
    ),
  })
const post = (path: string, body: unknown) => qbo.request('POST', path, { body })
const asRes = (key: string, v: any) => ({
  status: 200,
  intuitTid: null,
  headers: {},
  body: { [key]: v },
})
const getInv = async (id: string) =>
  ((await qbo.request('GET', `/invoice/${id}`)).body as any).Invoice
const getPay = async (id: string) =>
  ((await qbo.request('GET', `/payment/${id}`)).body as any).Payment
let n = 0
const newCustomer = async () =>
  ((await post('/customer', { DisplayName: `${m}-c${++n}` })).body as any).Customer
const newInvoice = async (c: any, amount: number) =>
  ((await post('/invoice', { CustomerRef: { value: c.Id }, Line: [line(amount)] })).body as any)
    .Invoice
const payBody = (c: any, total: number, apply: [string, number][]) => ({
  CustomerRef: { value: c.Id },
  TotalAmt: total,
  Line: apply.map(([id, amt]) => ({ Amount: amt, LinkedTxn: [{ TxnId: id, TxnType: 'Invoice' }] })),
})

// Partial, second partial, final
let c = await newCustomer()
const a = await newInvoice(c, 100)
for (const amt of [30, 50, 20]) {
  const r = await post('/payment', payBody(c, amt, [[a.Id, amt]]))
  show(`payment ${amt} on invoice 100`, r, pay)
  show('  invoice after', asRes('Invoice', await getInv(a.Id)), inv)
}
show(
  'payment 10 on the fully paid invoice',
  await post('/payment', payBody(c, 10, [[a.Id, 10]])),
  pay
)

// Overpayment: line amount above the open balance; TotalAmt above the applied amount
c = await newCustomer()
const o = await newInvoice(c, 100)
show(
  'line 120 on an invoice with balance 100',
  await post('/payment', payBody(c, 120, [[o.Id, 120]])),
  pay
)
show('TotalAmt 120, line 100', await post('/payment', payBody(c, 120, [[o.Id, 100]])), pay)
show('  invoice after', asRes('Invoice', await getInv(o.Id)), inv)
c = await newCustomer()
const o2 = await newInvoice(c, 100)
show(
  'TotalAmt 50, line 80 (lines exceed total)',
  await post('/payment', payBody(c, 50, [[o2.Id, 80]])),
  pay
)
show(
  'no TotalAmt, line 40',
  await post('/payment', {
    CustomerRef: { value: c.Id },
    Line: [{ Amount: 40, LinkedTxn: [{ TxnId: o2.Id, TxnType: 'Invoice' }] }],
  }),
  pay
)
show(
  'TotalAmt 0, no lines',
  await post('/payment', { CustomerRef: { value: c.Id }, TotalAmt: 0 }),
  pay
)
show('TotalAmt -5', await post('/payment', { CustomerRef: { value: c.Id }, TotalAmt: -5 }), pay)

// One payment over two invoices
c = await newCustomer()
const t1 = await newInvoice(c, 60)
const t2 = await newInvoice(c, 40)
const r2 = await post(
  '/payment',
  payBody(c, 100, [
    [t1.Id, 60],
    [t2.Id, 40],
  ])
)
show('payment 100 split 60 / 40 over two invoices', r2, pay)
show('  invoice 1', asRes('Invoice', await getInv(t1.Id)), inv)
show('  invoice 2', asRes('Invoice', await getInv(t2.Id)), inv)
const both = (r2.body as any).Payment
show(
  'one line linking both invoices',
  await post('/payment', {
    CustomerRef: { value: c.Id },
    TotalAmt: 10,
    Line: [
      {
        Amount: 10,
        LinkedTxn: [
          { TxnId: t1.Id, TxnType: 'Invoice' },
          { TxnId: t2.Id, TxnType: 'Invoice' },
        ],
      },
    ],
  }),
  pay
)

// Edit a payment: amount down, then drop one invoice
let p = await getPay(both.Id)
show(
  'payment edited to 70 = 60 + 10',
  await post('/payment', {
    ...payBody(c, 70, [
      [t1.Id, 60],
      [t2.Id, 10],
    ]),
    Id: p.Id,
    SyncToken: p.SyncToken,
    sparse: true,
  }),
  pay
)
show('  invoice 2', asRes('Invoice', await getInv(t2.Id)), inv)
p = await getPay(both.Id)
show(
  'payment edited to 60, invoice 2 line dropped',
  await post('/payment', {
    ...payBody(c, 60, [[t1.Id, 60]]),
    Id: p.Id,
    SyncToken: p.SyncToken,
    sparse: true,
  }),
  pay
)
show('  invoice 2', asRes('Invoice', await getInv(t2.Id)), inv)
p = await getPay(both.Id)
show(
  'payment edit with stale SyncToken',
  await post('/payment', {
    ...payBody(c, 60, [[t1.Id, 60]]),
    Id: p.Id,
    SyncToken: '0',
    sparse: true,
  }),
  pay
)

// Applying to another customer's invoice
const other = await newCustomer()
const oi = await newInvoice(other, 50)
show(
  "payment linking another customer's invoice",
  await post('/payment', payBody(c, 50, [[oi.Id, 50]])),
  pay
)
show("  other customer's invoice after", asRes('Invoice', await getInv(oi.Id)), inv)
show(
  'payment linking an unknown invoice id',
  await post('/payment', payBody(c, 5, [['999999', 5]])),
  pay
)

// Change the customer of a partially paid invoice
c = await newCustomer()
const pc = await newInvoice(c, 100)
const pp = ((await post('/payment', payBody(c, 40, [[pc.Id, 40]]))).body as any).Payment
const fresh = await getInv(pc.Id)
const nc = await newCustomer()
show(
  'change CustomerRef of a partially paid invoice',
  await post('/invoice', {
    Id: fresh.Id,
    SyncToken: fresh.SyncToken,
    sparse: true,
    CustomerRef: { value: nc.Id },
  }),
  inv
)
show('  its payment after', asRes('Payment', await getPay(pp.Id)), pay)
