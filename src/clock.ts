// Source of the current time, injectable so tests control it.
export interface Clock {
  now(): Date
}

export const systemClock: Clock = { now: () => new Date() }
