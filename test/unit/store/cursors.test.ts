import { afterEach, beforeEach, expect, it } from 'vitest'
import { freshDb } from '../../harness/fresh-db.js'
import { getCursor, setCursor } from '../../../src/store/cursors.js'

let t: Awaited<ReturnType<typeof freshDb>>
beforeEach(async () => {
  t = await freshDb()
})
afterEach(() => t.destroy())

it('is null before the first set', async () => {
  expect(await getCursor(t.db, 'qbo')).toBeNull()
})

it('keeps the last value per system', async () => {
  await setCursor(t.db, 'qbo', 'a')
  await setCursor(t.db, 'qbo', 'b')
  await setCursor(t.db, 'invoicing', 'x')
  expect(await getCursor(t.db, 'qbo')).toBe('b')
  expect(await getCursor(t.db, 'invoicing')).toBe('x')
})
