// One-time OAuth2 consent: starts a local server on the redirect URI, prints the consent
// URL, exchanges the code for tokens and stores realm id + tokens in the connection file.
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { authorizeUrl, exchangeCode } from '../../src/qbo/index.js'
import { CONNECTION_PATH, oauthConfig, tokenStore } from './setup.js'

const config = oauthConfig()
const redirectUri = new URL(config.redirectUri)
const state = randomBytes(16).toString('hex')

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', redirectUri)
  if (url.pathname !== redirectUri.pathname) {
    res.writeHead(404).end()
    return
  }
  try {
    if (url.searchParams.get('state') !== state) throw new Error('state mismatch')
    const error = url.searchParams.get('error')
    if (error) throw new Error(`authorization denied: ${error}`)
    const code = url.searchParams.get('code')
    const realmId = url.searchParams.get('realmId')
    if (!code || !realmId) throw new Error('missing code or realmId in callback')

    await tokenStore.save({ realmId, ...(await exchangeCode(config, code)) })
    res.writeHead(200, { 'content-type': 'text/plain' }).end('Connected. You can close this tab.')
    console.log(`Connected to realm ${realmId}. Tokens saved to ${CONNECTION_PATH}.`)
  } catch (err) {
    res.writeHead(400, { 'content-type': 'text/plain' }).end(`Failed: ${(err as Error).message}`)
    console.error('OAuth failed:', (err as Error).message)
    process.exitCode = 1
  } finally {
    server.close()
  }
})

server.listen(Number(redirectUri.port || 80), () => {
  console.log('Open this URL, sign in and pick the sandbox company:\n')
  console.log(authorizeUrl(config, state))
})
