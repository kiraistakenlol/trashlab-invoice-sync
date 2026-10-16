// One-time OAuth2 authorization-code flow against Intuit.
// Starts a local server on the redirect URI, prints the consent URL, exchanges the code
// for tokens and stores realm id + tokens in the repo-root .env.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readEnv, requireEnv } from './env.js';
import { exchangeCode, saveTokens } from './oauth.js';

const AUTHORIZE_URL = 'https://appcenter.intuit.com/connect/oauth2';
const SCOPE = 'com.intuit.quickbooks.accounting';

const env = readEnv();
const clientId = requireEnv(env, 'QBO_CLIENT_ID');
const redirectUri = new URL(requireEnv(env, 'QBO_REDIRECT_URI'));
const state = randomBytes(16).toString('hex');

const consentUrl = new URL(AUTHORIZE_URL);
consentUrl.search = new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirectUri.toString(),
  response_type: 'code',
  scope: SCOPE,
  state,
}).toString();

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', redirectUri);
  if (url.pathname !== redirectUri.pathname) {
    res.writeHead(404).end();
    return;
  }
  try {
    if (url.searchParams.get('state') !== state) throw new Error('state mismatch');
    const error = url.searchParams.get('error');
    if (error) throw new Error(`authorization denied: ${error}`);
    const code = url.searchParams.get('code');
    const realmId = url.searchParams.get('realmId');
    if (!code || !realmId) throw new Error('missing code or realmId in callback');

    const tokens = await exchangeCode(code);
    saveTokens(tokens, realmId);
    res.writeHead(200, { 'content-type': 'text/plain' }).end('Connected. You can close this tab.');
    console.log(`Connected to realm ${realmId}. Tokens saved to .env.`);
  } catch (err) {
    res.writeHead(400, { 'content-type': 'text/plain' }).end(`Failed: ${(err as Error).message}`);
    console.error('OAuth failed:', (err as Error).message);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});

server.listen(Number(redirectUri.port || 80), () => {
  console.log('Open this URL, sign in and pick the sandbox company:\n');
  console.log(consentUrl.toString());
});
