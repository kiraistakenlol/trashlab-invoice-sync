// Shared helpers for exploration scripts: print a request's outcome compactly.
import type { QboResponse } from '../../../src/qbo/index.js'

// Prints status, intuit_tid and either the whole body or the part `pick` selects.
export function show(label: string, res: QboResponse, pick?: (body: any) => unknown): void {
  console.log(`\n=== ${label}`)
  console.log(`status: ${res.status}  intuit_tid: ${res.intuitTid}`)
  const shown = pick ? safePick(res.body, pick) : res.body
  console.log(typeof shown === 'string' ? shown : JSON.stringify(shown, null, 2))
}

function safePick(body: any, pick: (body: any) => unknown): unknown {
  try {
    return pick(body) ?? body
  } catch {
    return body
  }
}

// Unique marker for test records, e.g. "EXPLORE-03-1729080000000".
export function marker(script: string): string {
  return `EXPLORE-${script}-${Date.now()}`
}
