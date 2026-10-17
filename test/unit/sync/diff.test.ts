import { describe, expect, it } from 'vitest'
import { diff, isEmpty } from '../../../src/sync/diff.js'
import type { NeutralInvoice } from '../../../src/sync/neutral.js'

const line = (item: string, amount = '10.00') => ({
  item,
  description: null,
  quantity: '1',
  unitPrice: amount,
  amount,
})

const base: NeutralInvoice = {
  number: 'INV-1',
  customer: 'c1',
  issueDate: '2026-01-01',
  dueDate: '2026-01-31',
  memo: null,
  lines: [line('a'), line('b')],
  tax: '0.00',
  voided: false,
}

describe('diff', () => {
  it('copies a change made only in invoicing to QBO', () => {
    const d = diff(base, { ...base, memo: 'hi' }, base)
    expect(d.toQbo).toEqual({ memo: 'hi' })
    expect(d.toInvoicing).toEqual({})
    expect(d.conflicts).toEqual([])
  })

  it('copies a change made only in QBO to invoicing', () => {
    const d = diff(base, base, { ...base, dueDate: '2026-02-15' })
    expect(d.toInvoicing).toEqual({ dueDate: '2026-02-15' })
    expect(d.toQbo).toEqual({})
    expect(d.conflicts).toEqual([])
  })

  it('does nothing when both sides changed to the same value', () => {
    const changed = { ...base, memo: 'same' }
    expect(isEmpty(diff(base, changed, changed))).toBe(true)
  })

  it('flags a field changed to different values on both sides', () => {
    const d = diff(base, { ...base, memo: 'a' }, { ...base, memo: 'b' })
    expect(d.conflicts).toEqual([{ field: 'memo', snapshot: null, invoicing: 'a', qbo: 'b' }])
    expect(d.toQbo).toEqual({})
    expect(d.toInvoicing).toEqual({})
  })

  it('is empty when nothing changed', () => {
    const d = diff(base, base, base)
    expect(isEmpty(d)).toBe(true)
  })

  it('merges changes to different fields', () => {
    const d = diff(base, { ...base, memo: 'x' }, { ...base, tax: '1.00' })
    expect(d.toQbo).toEqual({ memo: 'x' })
    expect(d.toInvoicing).toEqual({ tax: '1.00' })
    expect(isEmpty(d)).toBe(false)
  })

  it('makes every differing field a conflict without a snapshot', () => {
    const d = diff<NeutralInvoice>(
      null,
      { ...base, memo: 'a', tax: '1.00' },
      { ...base, memo: 'b' }
    )
    expect(d.conflicts.map((c) => c.field).sort()).toEqual(['memo', 'tax'])
    expect(d.toQbo).toEqual({})
    expect(d.toInvoicing).toEqual({})
  })

  it('leaves equal fields alone without a snapshot', () => {
    expect(isEmpty(diff<NeutralInvoice>(null, base, { ...base }))).toBe(true)
  })

  it('compares lines as one field', () => {
    const first = { ...base, lines: [line('a', '11.00'), line('b')] }
    const second = { ...base, lines: [line('a'), line('b', '12.00')] }
    const d = diff(base, first, second)
    expect(d.conflicts).toHaveLength(1)
    expect(d.conflicts[0]).toMatchObject({
      field: 'lines',
      invoicing: first.lines,
      qbo: second.lines,
    })
  })
})
