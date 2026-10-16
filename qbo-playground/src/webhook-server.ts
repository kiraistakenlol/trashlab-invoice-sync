// Local QBO webhook receiver for exploration: logs every delivery (headers + raw body +
// signature check) as one JSON line to webhooks.log (gitignored) and answers with a chosen
// status after a chosen delay, to observe retries.
//   pnpm qbo:webhooks [port=4001] [status=200] [delayMs=0]
import { createHmac, timingSafeEqual } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { readEnv } from './env.js';

const LOG_PATH = fileURLToPath(new URL('../webhooks.log', import.meta.url));
const [port = 4001, status = 200, delayMs = 0] = process.argv.slice(2).map(Number);
const verifier = readEnv().QBO_WEBHOOK_VERIFIER_TOKEN;
if (!verifier) console.warn('QBO_WEBHOOK_VERIFIER_TOKEN not set in .env: signatures not checked');

// intuit-signature = base64(HMAC-SHA256(raw body, verifier token)).
function signatureValid(raw: Buffer, header: string | undefined): boolean | null {
  if (!verifier || !header) return null;
  const expected = createHmac('sha256', verifier).update(raw).digest();
  const got = Buffer.from(header, 'base64');
  return got.length === expected.length && timingSafeEqual(got, expected);
}

createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    const entry = {
      receivedAt: new Date().toISOString(),
      method: req.method,
      url: req.url,
      headers: req.headers,
      signatureValid: signatureValid(raw, req.headers['intuit-signature'] as string | undefined),
      body: raw.toString('utf8'),
      answered: status,
    };
    appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n');
    console.log(`${entry.receivedAt} ${req.method} ${req.url} ${raw.length}B sig=${entry.signatureValid} -> ${status}`);
    setTimeout(() => res.writeHead(status).end(), delayMs);
  });
}).listen(port, () => console.log(`webhook receiver on :${port}, answering ${status} after ${delayMs} ms, log ${LOG_PATH}`));
