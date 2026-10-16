// Ad-hoc calls against the sandbox:
//   pnpm call GET /companyinfo/<realmId>
//   pnpm call query "select * from Invoice maxresults 5"
//   pnpm call POST /invoice '{"CustomerRef":{"value":"1"},"Line":[...]}' [requestId]
import { client } from './setup.js';

const [method, target, body, requestId] = process.argv.slice(2);
if (!method || !target) {
  console.error('usage: pnpm call <GET|POST|query> <path|sql> [jsonBody] [requestId]');
  process.exit(1);
}

const qbo = client();
const res =
  method.toLowerCase() === 'query'
    ? await qbo.query(target)
    : await qbo.request(method.toUpperCase(), target, {
        body: body ? JSON.parse(body) : undefined,
        requestId,
      });

console.log(`status: ${res.status}  intuit_tid: ${res.intuitTid}`);
console.log(JSON.stringify(res.body, null, 2));
