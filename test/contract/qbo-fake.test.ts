// The QBO contract suite against the in-memory fake.
import { randomBytes } from 'node:crypto'
import { beforeEach } from 'vitest'
import { FakeQbo } from '../fakes/fake-qbo.js'
import { qboContract } from './qbo-contract.js'

let fake: FakeQbo

beforeEach(() => {
  fake = new FakeQbo()
})

qboContract({
  client: () => fake,
  prefix: 'f' + randomBytes(5).toString('hex').slice(0, 5),
  settle: (read) => read(),
})
