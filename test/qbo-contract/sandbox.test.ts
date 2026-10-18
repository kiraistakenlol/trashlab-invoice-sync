// The QBO contract suite against the real sandbox.
import { randomBytes } from 'node:crypto'
import { eventually } from '../harness/eventually.js'
import { qboContract } from './contract.js'
import { sandboxClient } from '../harness/sandbox.js'

qboContract({
  client: sandboxClient,
  prefix: 's' + randomBytes(5).toString('hex').slice(0, 5),
  settle: eventually,
  cleanup: true,
})
