// Re-checks the spec's load-bearing claims with fresh records, independently of the
// original scripts: delete vs stale SyncToken, read-after-write, CDC visibility behind a
// cursor, requestid reuse across records, lines resent without Ids on a paid invoice, and
// line changes on an invoice that carries a transaction tax code.
// Usage: pnpm qbo:explore 13-verify
import { randomUUID } from 'node:crypto';
import { client } from '../setup.js';
import { marker } from './lib.js';

const qbo = client();
const m = marker('13');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const line = (amount: number, id?: string) => ({ ...(id ? { Id: id } : {}), Amount: amount, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: { value: '1' } } });
const post = async (path: string, body: unknown, query?: Record<string, string>, requestId?: string) => {
  const r = await qbo.request('POST', path, { body, query, requestId });
  return { status: r.status, tid: r.intuitTid, body: r.body as any };
};
const get = async (path: string) => (await qbo.request('GET', path)).body as any;
const inv = (r: { body: any }) => r.body.Invoice;
const brief = (i: any) => i && `Id ${i.Id} tok ${i.SyncToken} total ${i.TotalAmt} bal ${i.Balance} lines ${JSON.stringify(i.Line?.filter((l: any) => l.Id).map((l: any) => `${l.Id}:${l.Amount}`))} linked ${JSON.stringify(i.LinkedTxn?.map((x: any) => x.TxnId))}`;
const say = (label: string, ...rest: unknown[]) => console.log(`\n=== ${label}\n`, ...rest);

const cust = (await post('/customer', { DisplayName: `${m}-cust` })).body.Customer;

// 1. Delete with a stale SyncToken.
{
  let a = inv(await post('/invoice', { CustomerRef: { value: cust.Id }, Line: [line(10)] }));
  a = inv(await post('/invoice', { Id: a.Id, SyncToken: a.SyncToken, sparse: true, PrivateNote: `${m}-edit` }));
  const del = await post('/invoice', { Id: a.Id, SyncToken: '0' }, { operation: 'delete' });
  say('1 delete with stale token 0 (current 1)', del.status, del.tid, JSON.stringify(del.body).slice(0, 200));
}

// 2. Read-after-write: GET and query immediately after a write.
{
  const a = inv(await post('/invoice', { CustomerRef: { value: cust.Id }, Line: [line(20)] }));
  const results: string[] = [];
  let cur = a;
  for (let i = 0; i < 5; i++) {
    cur = inv(await post('/invoice', { Id: cur.Id, SyncToken: cur.SyncToken, sparse: true, PrivateNote: `${m}-raw-${i}` }));
    const [g, q] = await Promise.all([get(`/invoice/${cur.Id}`), qbo.query(`select * from Invoice where Id = '${cur.Id}'`)]);
    results.push(`write tok ${cur.SyncToken} -> GET tok ${g.Invoice.SyncToken}, query tok ${(q.body as any).QueryResponse.Invoice?.[0]?.SyncToken}`);
  }
  say('2 read-after-write', '\n' + results.join('\n'));
}

// 3. CDC behind a cursor: write, then poll CDC with changedSince = LastUpdatedTime - 1 s every 100 ms.
{
  let a = inv(await post('/invoice', { CustomerRef: { value: cust.Id }, Line: [line(30)] }));
  const delays: string[] = [];
  for (let i = 0; i < 8; i++) {
    a = inv(await post('/invoice', { Id: a.Id, SyncToken: a.SyncToken, sparse: true, PrivateNote: `${m}-cdc-${i}` }));
    const t0 = Date.now();
    const since = new Date(Date.parse(a.MetaData.LastUpdatedTime) - 1000).toISOString();
    let polls = 0;
    let seen = false;
    while (Date.now() - t0 < 15_000) {
      polls++;
      const b = (await qbo.request('GET', '/cdc', { query: { entities: 'Invoice', changedSince: since } })).body as any;
      const hit = b.CDCResponse?.[0]?.QueryResponse?.flatMap((g: any) => g.Invoice ?? []).find((x: any) => x.Id === a.Id);
      if (hit?.SyncToken === a.SyncToken) { seen = true; break; }
      await sleep(100);
    }
    delays.push(`tok ${a.SyncToken} LastUpdated ${a.MetaData.LastUpdatedTime}: ${seen ? `visible after ${Date.now() - t0} ms (${polls} polls)` : 'NOT visible in 15 s'}`);
    await sleep(1500);
  }
  say('3 CDC visibility', '\n' + delays.join('\n'));
}

// 4. One requestid used for updates of two different invoices.
{
  const a = inv(await post('/invoice', { CustomerRef: { value: cust.Id }, Line: [line(40)] }));
  const b = inv(await post('/invoice', { CustomerRef: { value: cust.Id }, Line: [line(41)] }));
  const key = randomUUID();
  const ra = await post('/invoice', { Id: a.Id, SyncToken: a.SyncToken, sparse: true, PrivateNote: `${m}-A` }, undefined, key);
  const rb = await post('/invoice', { Id: b.Id, SyncToken: b.SyncToken, sparse: true, PrivateNote: `${m}-B` }, undefined, key);
  const bNow = await get(`/invoice/${b.Id}`);
  say('4 same key, update of A then of B', `A: ${ra.status} ${ra.tid} ${brief(inv(ra))}\n B: ${rb.status} ${rb.tid} returned ${rb.body.Invoice ? brief(inv(rb)) : JSON.stringify(rb.body).slice(0, 300)}\n B actually: note=${bNow.Invoice.PrivateNote} tok ${bNow.Invoice.SyncToken}`);
  // create key reused for an update of the same entity type
  const k2 = randomUUID();
  const c = await post('/invoice', { CustomerRef: { value: cust.Id }, Line: [line(42)] }, undefined, k2);
  const u = await post('/invoice', { Id: a.Id, SyncToken: (await get(`/invoice/${a.Id}`)).Invoice.SyncToken, sparse: true, PrivateNote: `${m}-A2` }, undefined, k2);
  say('4b create key reused for an update of another invoice', `create ${c.status} ${brief(inv(c))}\n update ${u.status} ${u.tid} returned ${u.body.Invoice ? brief(inv(u)) : JSON.stringify(u.body).slice(0, 300)}`);
}

// 5. Lines resent without Ids on a partially paid invoice (same total, then a higher total).
{
  const pc = (await post('/customer', { DisplayName: `${m}-paycust` })).body.Customer;
  let a = inv(await post('/invoice', { CustomerRef: { value: pc.Id }, Line: [line(60), line(40)] }));
  const pay = (await post('/payment', { CustomerRef: { value: pc.Id }, TotalAmt: 30, Line: [{ Amount: 30, LinkedTxn: [{ TxnId: a.Id, TxnType: 'Invoice' }] }] })).body.Payment;
  a = await get(`/invoice/${a.Id}`).then((x) => x.Invoice);
  const before = brief(a);
  const r1 = inv(await post('/invoice', { Id: a.Id, SyncToken: a.SyncToken, sparse: true, Line: [line(60), line(40)] }));
  const r2 = inv(await post('/invoice', { Id: a.Id, SyncToken: r1.SyncToken, sparse: true, Line: [line(70), line(40)] }));
  const p = (await get(`/payment/${pay.Id}`)).Payment;
  say('5 lines without Ids on a partly paid invoice', `before ${before}\n same total ${brief(r1)}\n raised ${brief(r2)}\n payment unapplied ${p.UnappliedAmt} lines ${JSON.stringify(p.Line.map((l: any) => [l.Amount, l.LinkedTxn.map((x: any) => x.TxnId)]))}`);
}

// 6. Line changes on an invoice that carries TxnTaxCodeRef (set by an API tax create, or by
// any save in the QBO UI).
{
  const t = (r: { status: number; tid: string | null; body: any }) => r.body.Invoice
    ? `${r.status} tok ${r.body.Invoice.SyncToken} total ${r.body.Invoice.TotalAmt} tax ${r.body.Invoice.TxnTaxDetail?.TotalTax} code ${r.body.Invoice.TxnTaxDetail?.TxnTaxCodeRef?.value}`
    : `${r.status} ${r.tid} ${JSON.stringify(r.body.Fault?.Error?.map((e: any) => [e.code, e.Detail]))}`;
  const taxed = (amount: number, code: string, id?: string) => ({ ...line(amount, id), SalesItemLineDetail: { ItemRef: { value: '1' }, TaxCodeRef: { value: code } } });
  const c = await post('/invoice', { CustomerRef: { value: cust.Id }, Line: [taxed(100, 'TAX')], TxnTaxDetail: { TxnTaxCodeRef: { value: '2' } } });
  const a = inv(c);
  const out = [`create TAX + TxnTaxCodeRef: ${t(c)}`];
  out.push(`sparse PrivateNote: ${t(await post('/invoice', { Id: a.Id, SyncToken: a.SyncToken, sparse: true, PrivateNote: `${m}-tax` }))}`);
  const cur = (await get(`/invoice/${a.Id}`)).Invoice;
  out.push(`sparse Line TAX, no TxnTaxDetail: ${t(await post('/invoice', { Id: a.Id, SyncToken: cur.SyncToken, sparse: true, Line: [taxed(200, 'TAX', '1')] }))}`);
  out.push(`sparse Line NON, no TxnTaxDetail: ${t(await post('/invoice', { Id: a.Id, SyncToken: cur.SyncToken, sparse: true, Line: [taxed(200, 'NON', '1')] }))}`);
  out.push(`sparse Line NON + TxnTaxCodeRef: ${t(await post('/invoice', { Id: a.Id, SyncToken: cur.SyncToken, sparse: true, Line: [taxed(200, 'NON', '1')], TxnTaxDetail: { TxnTaxCodeRef: { value: '2' } } }))}`);
  say('6 line changes on an invoice with TxnTaxCodeRef', '\n' + out.join('\n'));
}
