import { afterEach, describe, expect, it, vi } from 'vitest'
import { eventually } from '../../harness/eventually.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('eventually', () => {
  it('returns once ok', async () => {
    const read = vi.fn().mockResolvedValue(1)
    expect(await eventually(read, (v) => v === 1)).toBe(1)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('retries until ok', async () => {
    const read = vi.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(0).mockResolvedValue(1)
    expect(await eventually(read, (v) => v === 1, { intervalMs: 1 })).toBe(1)
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('throws after the timeout with the last value', async () => {
    vi.useFakeTimers()
    const result = eventually(
      async () => 'stale',
      (v) => v === 'fresh',
      {
        timeoutMs: 1000,
        intervalMs: 250,
      }
    )
    const assertion = expect(result).rejects.toThrow(/"stale"/)
    await vi.advanceTimersByTimeAsync(1500)
    await assertion
  })
})
