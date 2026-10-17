import { describe, expect, it } from 'vitest'
import { add, cmp, isZero, lineAmount, min, percentOf, sub, toMoney } from '../../src/money.js'

describe('money', () => {
  it('adds without float error', () => expect(add('0.10', '0.20')).toBe('0.30'))
  it('adds nothing to zero', () => expect(add()).toBe('0.00'))
  it('subtracts', () => expect(sub('100.00', '30.00')).toBe('70.00'))
  it('multiplies exactly', () => expect(lineAmount('2', '50.00')).toBe('100.00'))
  it('rejects a product with more than 2 decimals', () =>
    expect(lineAmount('1.5', '0.01')).toBeNull())
  it('takes 8 % of 15.00 as 1.20', () => expect(percentOf('15.00', '0.08')).toBe('1.20'))
  it('rounds half up', () => expect(percentOf('10.05', '0.5')).toBe('5.03'))
  it('normalizes a QBO number', () => expect(toMoney(108)).toBe('108.00'))
  it('normalizes a decimal string', () => expect(toMoney('1.5')).toBe('1.50'))
  it('compares', () => {
    expect(cmp('9.99', '10.00')).toBe(-1)
    expect(cmp('10.00', '10.00')).toBe(0)
    expect(cmp('10.01', '10.00')).toBe(1)
    expect(isZero('0.00')).toBe(true)
    expect(isZero('0.01')).toBe(false)
  })
  it('takes the smaller amount', () => expect(min('5.00', '3.50')).toBe('3.50'))
})
