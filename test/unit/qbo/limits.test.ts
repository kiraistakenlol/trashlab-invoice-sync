import { describe, expect, it } from 'vitest'
import { checkTextLimits, QboTextTooLongError, TEXT_LIMITS } from '../../../src/qbo/limits.js'

const text = (length: number) => 'x'.repeat(length)

describe('checkTextLimits', () => {
  it('accepts every field at its limit', () => {
    expect(() =>
      checkTextLimits({
        DocNumber: text(TEXT_LIMITS.DocNumber),
        CustomerMemo: { value: text(TEXT_LIMITS.CustomerMemo) },
        DisplayName: text(TEXT_LIMITS.DisplayName),
        Name: text(TEXT_LIMITS.Name),
        Line: [{ Description: text(TEXT_LIMITS.Description) }],
      })
    ).not.toThrow()
  })

  it.each([
    ['DocNumber', { DocNumber: text(22) }],
    ['CustomerMemo', { CustomerMemo: { value: text(1001) } }],
    ['DisplayName', { DisplayName: text(501) }],
    ['Name', { Name: text(101) }],
    ['Description', { Line: [{ Description: 'ok' }, { Description: text(4001) }] }],
  ])('rejects %s one character over its limit', (field, body) => {
    expect(() => checkTextLimits(body)).toThrow(QboTextTooLongError)
    expect(() => checkTextLimits(body)).toThrow(`${field} is`)
  })

  it('ignores fields that are not text', () => {
    expect(() => checkTextLimits({ Name: undefined, Line: [{ Amount: 10 }] })).not.toThrow()
  })
})
