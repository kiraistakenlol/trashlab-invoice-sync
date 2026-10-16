// Area 8 follow-up: webhook redelivery. Run while the receiver answers with an error or
// slowly (`pnpm webhooks 4001 500`, `pnpm webhooks 4001 200 15000`): makes one customer
// update and lists every delivery of that event for `waitMin` minutes, with the delay
// since the write and each delivery's intuit-t-id / intuit-created-time.
// Usage: pnpm qbo:explore 08b-webhook-retries <customerId> [waitMin=30]
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { client } from '../setup.js';
import { marker } from './lib.js';

const LOG_PATH = fileURLToPath(new URL('../../webhooks.log', import.meta.url));
const [customerId, waitMin = '30'] = process.argv.slice(2);
const qbo = client();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lines = () => (existsSync(LOG_PATH) ? readFileSync(LOG_PATH, 'utf8').split('\n').filter(Boolean) : []);

const cust = ((await qbo.request('GET', `/customer/${customerId}`)).body as any).Customer;
const skip = lines().length;
const t0 = Date.now();
const res = await qbo.request('POST', '/customer', { body: { Id: cust.Id, SyncToken: cust.SyncToken, sparse: true, CompanyName: marker('08b') } });
console.log(`${new Date(t0).toISOString()} customer ${cust.Id} updated -> HTTP ${res.status}, SyncToken ${(res.body as any).Customer?.SyncToken}`);

let seen = skip;
const deadline = t0 + Number(waitMin) * 60_000;
while (Date.now() < deadline) {
  const all = lines();
  for (const l of all.slice(seen)) {
    const e = JSON.parse(l);
    const ents = JSON.parse(e.body).eventNotifications?.flatMap((n: any) => n.dataChangeEvent.entities) ?? [];
    const mine = ents.some((x: any) => x.name === 'Customer' && x.id === cust.Id);
    console.log(`+${Math.round((Date.parse(e.receivedAt) - t0) / 1000)} s  ${mine ? 'THIS EVENT' : 'other'}  answered ${e.answered}  t-id ${e.headers['intuit-t-id']}  created ${e.headers['intuit-created-time']}  ${ents.map((x: any) => `${x.name} ${x.id} ${x.operation} ${x.lastUpdated}`).join('; ')}`);
  }
  seen = all.length;
  await sleep(5000);
}
console.log('done');
