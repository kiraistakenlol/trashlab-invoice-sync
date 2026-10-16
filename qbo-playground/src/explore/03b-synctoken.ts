// Area 3 follow-up: a genuinely stale SyncToken, a numeric SyncToken, and whether a
// TxnDate / DocNumber survive a full update that omits them.
import { client } from '../setup.js';
import { marker, show } from './lib.js';

const qbo = client();
const m = marker('03b');
const err = (b: any) => b.Fault?.Error?.map((e: any) => `${e.code} ${e.Message} | ${e.Detail}`);
const brief = (b: any) => err(b) ?? { SyncToken: b.Invoice.SyncToken, TxnDate: b.Invoice.TxnDate, DocNumber: b.Invoice.DocNumber, PrivateNote: b.Invoice.PrivateNote };
const line = { Amount: 10, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: { value: '1' } } };

const cust = ((await qbo.request('POST', '/customer', { body: { DisplayName: `${m}-cust` } })).body as any).Customer;
let inv = ((await qbo.request('POST', '/invoice', { body: { CustomerRef: { value: cust.Id }, TxnDate: '2026-03-01', DocNumber: 'D-03b', Line: [line] } })).body as any).Invoice;
show('created', { status: 200, intuitTid: null, headers: {}, body: { Invoice: inv } }, brief);

let res = await qbo.request('POST', '/invoice', { body: { Id: inv.Id, SyncToken: '0', sparse: true, PrivateNote: 'first' } });
show('update with current token 0 -> bumps to 1', res, brief);
res = await qbo.request('POST', '/invoice', { body: { Id: inv.Id, SyncToken: '0', sparse: true, PrivateNote: 'stale' } });
show('update with stale token 0 (current is 1)', res, (b) => ({ errors: err(b), element: b.Fault?.Error?.[0]?.element }));
res = await qbo.request('POST', '/invoice', { body: { Id: inv.Id, SyncToken: 1, sparse: true, PrivateNote: 'numeric' } });
show('update with numeric current token 1', res, brief);

inv = ((await qbo.request('GET', `/invoice/${inv.Id}`)).body as any).Invoice;
res = await qbo.request('POST', '/invoice', { body: { Id: inv.Id, SyncToken: inv.SyncToken, CustomerRef: inv.CustomerRef, Line: [line] } });
show('full update omitting TxnDate, DocNumber, PrivateNote', res, brief);
