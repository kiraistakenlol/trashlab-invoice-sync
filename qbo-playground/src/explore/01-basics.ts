// Area 1: minorversion handling, response envelopes, error formats, query language,
// timestamp format.
import { createQboClient } from 'qbo-client';
import { client, fileTokenStore, oauthConfig } from '../setup.js';
import { show } from './lib.js';

const realmId = (await fileTokenStore.load())!.realmId;
const qbo = client();

// --- minorversion: which values are accepted, and does the response differ?
for (const mv of [null, '1', '40', '65', '70', '73', '74', '75', '76', '80', '999', 'abc']) {
  const res = await client({ minorVersion: mv }).request('GET', `/companyinfo/${realmId}`);
  show(`minorversion=${mv}`, res, (b) => (b.Fault ? b : { keys: Object.keys(b), time: b.time, companyInfoKeys: Object.keys(b.CompanyInfo).length }));
}

// Do newer minor versions change an Invoice's shape? Compare field sets of one invoice.
const first = await qbo.query('select * from Invoice maxresults 1');
const invoiceId = (first.body as any).QueryResponse.Invoice[0].Id;
const shapes: Record<string, string[]> = {};
for (const mv of [null, '1', '75']) {
  const res = await client({ minorVersion: mv }).request('GET', `/invoice/${invoiceId}`);
  shapes[String(mv)] = Object.keys((res.body as any).Invoice ?? {}).sort();
}
console.log('\n=== Invoice field sets by minorversion');
for (const [mv, keys] of Object.entries(shapes)) console.log(mv, keys.length, keys.join(','));
const all = new Set(Object.values(shapes).flat());
for (const k of all) {
  const missing = Object.entries(shapes).filter(([, ks]) => !ks.includes(k)).map(([mv]) => mv);
  if (missing.length) console.log(`  ${k}: missing in ${missing.join(',')}`);
}

// --- Envelopes
show('read envelope: GET /invoice/{id}', await qbo.request('GET', `/invoice/${invoiceId}`), (b) => ({
  topKeys: Object.keys(b),
  time: b.time,
  MetaData: b.Invoice.MetaData,
  SyncToken: b.Invoice.SyncToken,
}));
show('query envelope', first, (b) => ({ topKeys: Object.keys(b), qrKeys: Object.keys(b.QueryResponse), startPosition: b.QueryResponse.startPosition, maxResults: b.QueryResponse.maxResults }));

// --- Errors
show('not found: GET /invoice/999999999', await qbo.request('GET', '/invoice/999999999'));
show('unknown entity path: GET /nosuchentity/1', await qbo.request('GET', '/nosuchentity/1'));
show('query syntax error', await qbo.query('selec * from Invoice'));
show('query unknown property', await qbo.query('select * from Invoice where NoSuchField = 1'));
show('query unknown entity', await qbo.query('select * from NoSuchEntity'));
show('validation: POST /invoice with empty body', await qbo.request('POST', '/invoice', { body: {} }));
show('validation: POST /invoice with unknown customer', await qbo.request('POST', '/invoice', {
  body: { CustomerRef: { value: '999999' }, Line: [{ Amount: 10, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: { value: '1' } } }] },
}));
show('malformed JSON body', await qbo.request('POST', '/invoice', { body: '{not json' as unknown }));

const badAuth = createQboClient({
  oauth: oauthConfig(),
  environment: 'sandbox',
  tokenStore: {
    load: async () => ({ realmId, accessToken: 'invalid', refreshToken: 'x', accessTokenExpiresAt: new Date(Date.now() + 3600e3), refreshTokenExpiresAt: new Date(Date.now() + 3600e3) }),
    save: async () => {},
  },
});
const authRes = await badAuth.request('GET', `/companyinfo/${realmId}`);
show('invalid access token', authRes);
console.log('www-authenticate:', authRes.headers['www-authenticate']);

// --- Query language
show('field list on Invoice', await qbo.query('select Id, DocNumber, TotalAmt, MetaData.LastUpdatedTime from Invoice maxresults 2'), (b) => b.QueryResponse);
show('count(*)', await qbo.query('select count(*) from Invoice'), (b) => b.QueryResponse);
show('orderby LastUpdatedTime desc', await qbo.query('select * from Invoice orderby MetaData.LastUpdatedTime desc maxresults 3'), (b) => b.QueryResponse.Invoice.map((i: any) => [i.Id, i.MetaData.LastUpdatedTime]));
show('where LastUpdatedTime > 2020', await qbo.query("select * from Invoice where MetaData.LastUpdatedTime > '2020-01-01T00:00:00-07:00' maxresults 2"), (b) => ({ n: b.QueryResponse.Invoice?.length, ...b.QueryResponse, Invoice: undefined }));
show('where LastUpdatedTime > 2030 (empty result)', await qbo.query("select * from Invoice where MetaData.LastUpdatedTime > '2030-01-01T00:00:00Z'"));
show('maxresults 1000', await qbo.query('select Id from Invoice maxresults 1000'), (b) => ({ n: b.QueryResponse.Invoice?.length, maxResults: b.QueryResponse.maxResults }));
show('maxresults 1001', await qbo.query('select Id from Invoice maxresults 1001'), (b) => (b.Fault ? b : { n: b.QueryResponse.Invoice?.length, maxResults: b.QueryResponse.maxResults }));
show('no maxresults: default page size (Customer)', await qbo.query('select Id from Customer'), (b) => ({ n: b.QueryResponse.Customer?.length, maxResults: b.QueryResponse.maxResults }));
show('startposition 11 maxresults 5', await qbo.query('select Id from Invoice orderby Id startposition 11 maxresults 5'), (b) => b.QueryResponse);
show('where Id in (...)', await qbo.query(`select Id from Invoice where Id in ('${invoiceId}', '999999')`), (b) => b.QueryResponse);
show('where DocNumber = ...', await qbo.query("select Id, DocNumber from Invoice where DocNumber = '1001'"), (b) => b.QueryResponse);
show('OR operator (expected unsupported)', await qbo.query("select Id from Invoice where DocNumber = '1001' or DocNumber = '1002'"));
show('LIKE on DocNumber', await qbo.query("select Id, DocNumber from Invoice where DocNumber like '10%' maxresults 3"));

// --- Timestamps: format of MetaData and TxnDate across a few records
show('timestamp formats', await qbo.query('select * from Invoice maxresults 3'), (b) =>
  b.QueryResponse.Invoice.map((i: any) => ({ Id: i.Id, TxnDate: i.TxnDate, DueDate: i.DueDate, MetaData: i.MetaData })),
);
