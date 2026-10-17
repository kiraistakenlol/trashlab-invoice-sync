// Three-way per-field diff of two sides against their last common snapshot.
import { isDeepStrictEqual } from 'node:util'

export interface Diff<N> {
  toQbo: Partial<N>
  toInvoicing: Partial<N>
  conflicts: { field: keyof N; snapshot: unknown; invoicing: unknown; qbo: unknown }[]
}

// without a snapshot there is no common past: every differing field is a conflict
export function diff<N extends object>(snapshot: N | null, invoicing: N, qbo: N): Diff<N> {
  const result: Diff<N> = { toQbo: {}, toInvoicing: {}, conflicts: [] }
  for (const field of Object.keys(invoicing) as (keyof N)[]) {
    if (isDeepStrictEqual(invoicing[field], qbo[field])) continue
    const base = snapshot?.[field]
    if (snapshot && isDeepStrictEqual(invoicing[field], base)) {
      result.toInvoicing[field] = qbo[field]
    } else if (snapshot && isDeepStrictEqual(qbo[field], base)) {
      result.toQbo[field] = invoicing[field]
    } else {
      result.conflicts.push({
        field,
        snapshot: base ?? null,
        invoicing: invoicing[field],
        qbo: qbo[field],
      })
    }
  }
  return result
}

export const isEmpty = <N>(d: Diff<N>): boolean =>
  Object.keys(d.toQbo as object).length === 0 &&
  Object.keys(d.toInvoicing as object).length === 0 &&
  d.conflicts.length === 0
