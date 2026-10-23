// Area 10 follow-up: what triggers 429s - concurrency or rate. After a cool-down each
// time: sequential requests for a while, then parallel bursts of growing size.
import { client } from '../setup.js'

const qbo = client()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const read = () => qbo.query('select count(*) from Item')
const tally = (list: { status: number }[]) =>
  JSON.stringify(
    list.reduce<Record<number, number>>(
      (a, r) => ({ ...a, [r.status]: (a[r.status] ?? 0) + 1 }),
      {}
    )
  )

await sleep(60_000)
let t = Date.now()
const seq: { status: number }[] = []
while (Date.now() - t < 30_000) {
  seq.push(await read())
}
console.log(
  `sequential for 30 s: ${seq.length} requests (${Math.round((seq.length / (Date.now() - t)) * 60_000)}/min) ->`,
  tally(seq)
)

for (const n of [5, 8, 10, 12, 15, 20]) {
  await sleep(30_000)
  t = Date.now()
  const rs = await Promise.all(Array.from({ length: n }, read))
  console.log(`${n} parallel after 30 s rest (${Date.now() - t} ms) ->`, tally(rs))
}

// Sustained concurrency 4 for 30 s
await sleep(30_000)
t = Date.now()
const sus: { status: number }[] = []
await Promise.all(
  Array.from({ length: 4 }, async () => {
    while (Date.now() - t < 30_000) {
      sus.push(await read())
    }
  })
)
console.log(
  `4 workers for 30 s: ${sus.length} requests (${Math.round((sus.length / (Date.now() - t)) * 60_000)}/min) ->`,
  tally(sus)
)
