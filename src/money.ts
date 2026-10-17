// Decimal money arithmetic on 2-place strings; never JS number math.
import Big from 'big.js'

export type Money = string

const D = Big()
D.RM = Big.roundHalfUp

const fmt = (x: Big): Money => x.toFixed(2)

export const add = (...xs: Money[]): Money => fmt(xs.reduce((sum, x) => sum.plus(x), D(0)))

export const sub = (a: Money, b: Money): Money => fmt(D(a).minus(b))

export function lineAmount(quantity: string, unitPrice: Money): Money | null {
  const product = D(quantity).times(unitPrice)
  return product.round(2, Big.roundDown).eq(product) ? fmt(product) : null
}

export const percentOf = (amount: Money, rate: string): Money => fmt(D(amount).times(rate))

export const cmp = (a: Money, b: Money): -1 | 0 | 1 => D(a).cmp(b)

export const isZero = (a: Money): boolean => D(a).eq(0)

export const min = (a: Money, b: Money): Money => (cmp(a, b) <= 0 ? a : b)

// QBO sends amounts as JSON numbers
export const toMoney = (value: string | number): Money => fmt(D(value))
