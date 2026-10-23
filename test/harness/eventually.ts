// Polls a read until its value satisfies a predicate, for stores that settle after a write.
export async function eventually<T>(
  read: () => Promise<T>,
  ok: (v: T) => boolean,
  opts: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<T> {
  const { timeoutMs = 10_000, intervalMs = 250 } = opts
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (ok(value)) {
      return value
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `eventually timed out after ${timeoutMs} ms; last value: ${JSON.stringify(value)}`
      )
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}
