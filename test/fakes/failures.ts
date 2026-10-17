// Failure kinds a fake can be told to produce.
export type Failure = 'timeout_before_write' | 'timeout_after_write' | 'unavailable'

// The error AbortSignal.timeout produces
export const timeoutError = (): DOMException =>
  new DOMException('The operation was aborted due to timeout', 'TimeoutError')
