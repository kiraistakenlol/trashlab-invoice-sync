// Building blocks for entity specs: sides, versions and match results.
import type { Live, Match } from '../engine.js'
import type { Side } from '../neutral.js'

export const GONE = { state: 'gone' } as const

export const live = <N>(id: string, version: string | number, fields: N): Side<N> => ({
  state: 'live',
  id,
  version: String(version),
  fields,
})

export const versionOf = (r: { version: number } | { SyncToken: string }) =>
  'SyncToken' in r ? r.SyncToken : String(r.version)

// a created record maps like a read one
export function created<N>(side: Side<N>): Live<N> {
  if (side.state !== 'live') {
    throw new Error(`created record reads as ${side.state}`)
  }
  return side
}

export function matchOf(ids: string[]): Match {
  if (ids.length === 0) {
    return { found: 'none' }
  }
  if (ids.length === 1) {
    return { found: 'one', id: ids[0]! }
  }
  return { found: 'many', ids }
}
