// Area 5: void vs delete for invoices and payments. What a voided / deleted invoice looks
// like afterwards (GET, query), whether it can still be updated, and how voiding or
// deleting interacts with linked payments and balances.
import { client } from '../setup.js';
import { marker, show } from './lib.js';

const qbo = client();
const m = marker('05');
const err = (b: any) => b.Fault?.Error?.map((e: any) => `${e.code} ${e.Message} | ${e.Detail}`);
const line = (amount: number, d = 'L') => ({ Amount: amount, Description: d, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: { value: '1' }, Qty: 1, UnitPrice: amount } });
const inv = (b: any) =>
  err(b) ?? (b.Invoice && {
    Id: b.Invoice.Id, SyncToken: b.Invoice.SyncToken, status: b.Invoice.status, TotalAmt: b.Invoice.TotalAmt, Balance: b.Invoice.Balance,
    PrivateNote: b.Invoice.PrivateNote, DocNumber: b.Invoice.DocNumber, LinkedTxn: b.Invoice.LinkedTxn,
    Line: b.Invoice.Line?.map((l: any) => `${l.Id ?? '-'}:${l.DetailType}:${l.Amount}:${l.SalesItemLineDetail?.Qty ?? ''}x${l.SalesItemLineDetail?.UnitPrice ?? ''}`),
    LastUpdated: b.Invoice.MetaData?.LastUpdatedTime,
  });
const pay = (b: any) => err(b) ?? (b.Payment && { Id: b.Payment.Id, SyncToken: b.Payment.SyncToken, status: b.Payment.status, TotalAmt: b.Payment.TotalAmt, UnappliedAmt: b.Payment.UnappliedAmt, PrivateNote: b.Payment.PrivateNote, Line: b.Payment.Line?.map((l: any) => ({ Amount: l.Amount, LinkedTxn: l.LinkedTxn })) });
const post = (path: string, body: unknown, operation?: string) => qbo.request('POST', path, { body, ...(operation ? { query: { operation } } : {}) });
const get = async (id: string) => (await qbo.request('GET', `/invoice/${id}`)).body as any;
const newInvoice = async (doc: string, ...amounts: number[]) =>
  ((await post('/invoice', { CustomerRef: { value: cust.Id }, DocNumber: doc, PrivateNote: `${m}-${doc}`, Line: amounts.map((a, i) => line(a, `L${i + 1}`)) })).body as any).Invoice;
const newPayment = async (invoiceId: string, amount: number) =>
  ((await post('/payment', { CustomerRef: { value: cust.Id }, TotalAmt: amount, Line: [{ Amount: amount, LinkedTxn: [{ TxnId: invoiceId, TxnType: 'Invoice' }] }] })).body as any).Payment;
const q = async (sql: string) => ((await qbo.query(sql)).body as any).QueryResponse;

const cust = ((await post('/customer', { DisplayName: `${m}-cust` })).body as any).Customer;

// --- Void an unpaid invoice
let a = await newInvoice('I05-void', 30, 20);
let res = await post('/invoice', { Id: a.Id }, 'void');
show('void without SyncToken', res, inv);
res = await post('/invoice', { Id: a.Id, SyncToken: '9' }, 'void');
show('void with a wrong SyncToken', res, inv);
res = await post('/invoice', { Id: a.Id, SyncToken: a.SyncToken }, 'void');
show('void', res, inv);
show('GET after void', { status: 200, intuitTid: null, headers: {}, body: await get(a.Id) }, inv);
console.log('query by Id:', JSON.stringify((await q(`select Id, TotalAmt, Balance, PrivateNote from Invoice where Id = '${a.Id}'`)).Invoice));
console.log('query by DocNumber:', JSON.stringify((await q(`select Id from Invoice where DocNumber = 'I05-void'`)).Invoice));
a = (await get(a.Id)).Invoice;
res = await post('/invoice', { Id: a.Id, SyncToken: a.SyncToken }, 'void');
show('void again', res, inv);
a = (await get(a.Id)).Invoice;
res = await post('/invoice', { Id: a.Id, SyncToken: a.SyncToken, sparse: true, PrivateNote: `${m}-edited-after-void` });
show('sparse update of a voided invoice (PrivateNote)', res, inv);
a = (await get(a.Id)).Invoice;
res = await post('/invoice', { Id: a.Id, SyncToken: a.SyncToken, sparse: true, Line: [line(40, 'revived')] });
show('sparse update of a voided invoice (new line 40)', res, inv);
a = (await get(a.Id)).Invoice;
res = await post('/payment', { CustomerRef: { value: cust.Id }, TotalAmt: 5, Line: [{ Amount: 5, LinkedTxn: [{ TxnId: a.Id, TxnType: 'Invoice' }] }] });
show('payment against the voided invoice', res, pay);
a = (await get(a.Id)).Invoice;
res = await post('/invoice', { Id: a.Id, SyncToken: a.SyncToken }, 'delete');
show('delete the voided invoice', res, inv);

// --- Delete an unpaid invoice
let d = await newInvoice('I05-del', 15);
res = await post('/invoice', { Id: d.Id, SyncToken: '9' }, 'delete');
show('delete with a wrong SyncToken', res, inv);
res = await post('/invoice', { Id: d.Id, SyncToken: d.SyncToken }, 'delete');
show('delete', res);
res = await qbo.request('GET', `/invoice/${d.Id}`);
show('GET after delete', res, inv);
console.log('query by Id:', JSON.stringify(await q(`select Id from Invoice where Id = '${d.Id}'`)));
res = await post('/invoice', { Id: d.Id, SyncToken: d.SyncToken, sparse: true, PrivateNote: 'x' });
show('sparse update of a deleted invoice', res, inv);
res = await post('/invoice', { Id: d.Id, SyncToken: d.SyncToken }, 'void');
show('void a deleted invoice', res, inv);
const next = await newInvoice('I05-next', 1);
console.log(`\ndeleted invoice Id ${d.Id}, next new invoice Id ${next.Id} (DocNumber auto? ${next.DocNumber})`);

// --- Partially paid invoice: void, then delete
let pv = await newInvoice('I05-pvoid', 100);
const p1 = await newPayment(pv.Id, 40);
pv = (await get(pv.Id)).Invoice;
show('partially paid invoice', { status: 200, intuitTid: null, headers: {}, body: { Invoice: pv } }, inv);
res = await post('/invoice', { Id: pv.Id, SyncToken: pv.SyncToken }, 'void');
show('void a partially paid invoice', res, inv);
show('payment after its invoice was voided', await qbo.request('GET', `/payment/${p1.Id}`), pay);

let pd = await newInvoice('I05-pdel', 100);
const p2 = await newPayment(pd.Id, 40);
pd = (await get(pd.Id)).Invoice;
res = await post('/invoice', { Id: pd.Id, SyncToken: pd.SyncToken }, 'delete');
show('delete a partially paid invoice', res, inv);
show('payment after its invoice was deleted', await qbo.request('GET', `/payment/${p2.Id}`), pay);

// --- Edit a partially paid invoice
let pe = await newInvoice('I05-pedit', 100);
await newPayment(pe.Id, 60);
pe = (await get(pe.Id)).Invoice;
res = await post('/invoice', { Id: pe.Id, SyncToken: pe.SyncToken, sparse: true, Line: [line(80)] });
show('partially paid (60 of 100): total -> 80', res, inv);
pe = (await get(pe.Id)).Invoice;
res = await post('/invoice', { Id: pe.Id, SyncToken: pe.SyncToken, sparse: true, Line: [line(50)] });
show('partially paid (60): total -> 50, below the amount paid', res, inv);

// --- Void and delete a payment
let iv = await newInvoice('I05-payvoid', 100);
let pp = await newPayment(iv.Id, 25);
res = await post('/payment', { Id: pp.Id, SyncToken: pp.SyncToken }, 'void');
show('payment ?operation=void', res, pay);
pp = ((await qbo.request('GET', `/payment/${pp.Id}`)).body as any).Payment;
if (pp.TotalAmt !== 0) {
  res = await qbo.request('POST', '/payment', { body: { Id: pp.Id, SyncToken: pp.SyncToken, sparse: true }, query: { operation: 'update', include: 'void' } });
  show('payment ?operation=update&include=void', res, pay);
}
show('invoice after its payment was voided', { status: 200, intuitTid: null, headers: {}, body: await get(iv.Id) }, inv);

let idl = await newInvoice('I05-paydel', 100);
const pdl = await newPayment(idl.Id, 25);
res = await post('/payment', { Id: pdl.Id, SyncToken: pdl.SyncToken }, 'delete');
show('payment delete', res);
show('invoice after its payment was deleted', { status: 200, intuitTid: null, headers: {}, body: await get(idl.Id) }, inv);
