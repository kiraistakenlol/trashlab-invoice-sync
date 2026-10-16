// Area 5 follow-up, one fresh customer per scenario (the first run was confounded by
// unapplied payments being attached to later invoices of the same customer): does a new
// invoice pick up a customer's unapplied payment; what marks an invoice as voided; does
// delete check SyncToken; editing a partially paid invoice below the paid amount;
// payment against a voided invoice; voiding a payment.
import { client } from '../setup.js';
import { marker, show } from './lib.js';

const qbo = client();
const m = marker('05b');
const err = (b: any) => b.Fault?.Error?.map((e: any) => `${e.code} ${e.Message} | ${e.Detail}`);
const line = (amount: number) => ({ Amount: amount, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: { value: '1' } } });
const inv = (b: any) => err(b) ?? (b.Invoice && { Id: b.Invoice.Id, SyncToken: b.Invoice.SyncToken, TotalAmt: b.Invoice.TotalAmt, Balance: b.Invoice.Balance, PrivateNote: b.Invoice.PrivateNote, LinkedTxn: b.Invoice.LinkedTxn, Line: b.Invoice.Line?.map((l: any) => `${l.Id ?? '-'}:${l.Amount}`) });
const pay = (b: any) => err(b) ?? (b.Payment && { Id: b.Payment.Id, SyncToken: b.Payment.SyncToken, TotalAmt: b.Payment.TotalAmt, UnappliedAmt: b.Payment.UnappliedAmt, PrivateNote: b.Payment.PrivateNote, Line: b.Payment.Line?.map((l: any) => ({ Amount: l.Amount, LinkedTxn: l.LinkedTxn })) });
const post = (path: string, body: unknown, query?: Record<string, string>) => qbo.request('POST', path, { body, query });
const getInv = async (id: string) => ((await qbo.request('GET', `/invoice/${id}`)).body as any).Invoice;
const getPay = async (id: string) => ((await qbo.request('GET', `/payment/${id}`)).body as any).Payment;
const asRes = (key: string, v: any) => ({ status: 200, intuitTid: null, headers: {}, body: { [key]: v } });
let n = 0;
const newCustomer = async () => ((await post('/customer', { DisplayName: `${m}-c${++n}` })).body as any).Customer;
const newInvoice = async (c: any, amount: number) => ((await post('/invoice', { CustomerRef: { value: c.Id }, PrivateNote: `${m}-note`, Line: [line(amount)] })).body as any).Invoice;
const newPayment = async (c: any, amount: number, invoiceId?: string) =>
  post('/payment', { CustomerRef: { value: c.Id }, TotalAmt: amount, ...(invoiceId ? { Line: [{ Amount: amount, LinkedTxn: [{ TxnId: invoiceId, TxnType: 'Invoice' }] }] } : {}) });

// 1. A customer with an unapplied payment gets a new invoice
let c = await newCustomer();
const free = ((await newPayment(c, 30)).body as any).Payment;
show('unapplied payment', asRes('Payment', free), pay);
let i = await newInvoice(c, 100);
show('new invoice for that customer (create response)', asRes('Invoice', i), inv);
show('the invoice re-read', asRes('Invoice', await getInv(i.Id)), inv);
show('the payment re-read', asRes('Payment', await getPay(free.Id)), pay);

// 2. What marks a voided invoice: full body diff against a zero-amount invoice
c = await newCustomer();
const z = await newInvoice(c, 0);
let v = await newInvoice(c, 25);
await post('/invoice', { Id: v.Id, SyncToken: v.SyncToken }, { operation: 'void' });
const strip = (x: any) => { const { Id, SyncToken, MetaData, DocNumber, Line, ...rest } = x; return { ...rest, Line: Line.map(({ Id: _i, LineNum: _n, ...l }: any) => l) }; };
const zs = strip(await getInv(z.Id));
const vs = strip(await getInv(v.Id));
const keys = [...new Set([...Object.keys(zs), ...Object.keys(vs)])];
console.log('\n=== fields that differ: zero-amount invoice vs voided invoice');
for (const k of keys) if (JSON.stringify(zs[k]) !== JSON.stringify(vs[k])) console.log(`${k}: zero=${JSON.stringify(zs[k])} voided=${JSON.stringify(vs[k])}`);

// 3. Payment against a voided invoice
v = await getInv(v.Id);
show('payment against the voided invoice', await newPayment(c, 5, v.Id), pay);

// 4. Delete with a stale SyncToken
c = await newCustomer();
let d = await newInvoice(c, 10);
await post('/invoice', { Id: d.Id, SyncToken: d.SyncToken, sparse: true, PrivateNote: `${m}-bump` });
show('delete with stale SyncToken 0 (current 1)', await post('/invoice', { Id: d.Id, SyncToken: '0' }, { operation: 'delete' }));
d = await newInvoice(c, 10);
show('delete without SyncToken', await post('/invoice', { Id: d.Id }, { operation: 'delete' }));

// 5. Partially paid invoice edited below the amount paid
c = await newCustomer();
let e = await newInvoice(c, 100);
const p60 = ((await newPayment(c, 60, e.Id)).body as any).Payment;
e = await getInv(e.Id);
show('invoice 100, paid 60', asRes('Invoice', e), inv);
show('lines -> 50 (below 60 paid)', await post('/invoice', { Id: e.Id, SyncToken: e.SyncToken, sparse: true, Line: [line(50)] }), inv);
show('the payment afterwards', asRes('Payment', await getPay(p60.Id)), pay);

// 6. Void a payment: invoice balance and payment shape
c = await newCustomer();
const pv = await newInvoice(c, 100);
const p = ((await newPayment(c, 25, pv.Id)).body as any).Payment;
show('payment void (update + include=void)', await post('/payment', { Id: p.Id, SyncToken: p.SyncToken, sparse: true }, { operation: 'update', include: 'void' }), pay);
show('invoice after its payment was voided', asRes('Invoice', await getInv(pv.Id)), inv);
const pAfter = await getPay(p.Id);
show('voided payment re-read', asRes('Payment', pAfter), pay);
show('edit the voided payment (TotalAmt 25 again)', await post('/payment', { Id: pAfter.Id, SyncToken: pAfter.SyncToken, sparse: true, TotalAmt: 25, Line: [{ Amount: 25, LinkedTxn: [{ TxnId: pv.Id, TxnType: 'Invoice' }] }] }), pay);
