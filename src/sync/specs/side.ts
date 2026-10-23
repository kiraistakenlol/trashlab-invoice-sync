// Building blocks for entity specs: sides and match results.
import type { Live, Match } from '../engine.js'
import type { Side } from '../neutral.js'

export const GONE = { state: 'gone' } as const

export const live = <N>(id: string, version: string | number, fields: N): Side<N> => ({
  state: 'live',
  id,
  version: String(version),
  fields,
})

// a created record maps like a read one, so it must read as live
export function expectLive<N>(side: Side<N>): Live<N> {
  if (side.state !== 'live') {
    throw new Error(`created record reads as ${side.state}`)
  }
  return side
}

export function matchIds(ids: string[]): Match {
  const [first] = ids
  if (first === undefined) {
    return { found: 'none' }
  }
  if (ids.length === 1) {
    return { found: 'one', id: first }
  }
  return { found: 'many', ids }
}
