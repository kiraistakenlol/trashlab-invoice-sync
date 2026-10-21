// QBO's text length limits, verified on the sandbox (qbo-playground/qbo-spec.md, "Header
// fields"). QBO rejects a longer value with error 2050 and never shortens it.
export const TEXT_LIMITS = {
  DocNumber: 21,
  CustomerMemo: 1000,
  Description: 4000,
  DisplayName: 500,
  Name: 100,
} as const

export type TextField = keyof typeof TEXT_LIMITS

// A value too long for QBO, found before the request is sent.
export class QboTextTooLongError extends Error {
  constructor(
    readonly field: TextField,
    readonly length: number,
    readonly max: number
  ) {
    super(`${field} is ${length} characters; QBO allows at most ${max}`)
    this.name = 'QboTextTooLongError'
  }
}

interface TextFields {
  DocNumber?: unknown
  CustomerMemo?: { value?: unknown }
  DisplayName?: unknown
  Name?: unknown
  Line?: { Description?: unknown }[]
}

function textValues(body: TextFields): [TextField, unknown][] {
  const values: [TextField, unknown][] = [
    ['DocNumber', body.DocNumber],
    ['CustomerMemo', body.CustomerMemo?.value],
    ['DisplayName', body.DisplayName],
    ['Name', body.Name],
  ]
  for (const line of body.Line ?? []) {
    values.push(['Description', line.Description])
  }
  return values
}

// Throws QboTextTooLongError for the first text value longer than QBO accepts.
export function checkTextLimits(body: Record<string, unknown>): void {
  for (const [field, value] of textValues(body as TextFields)) {
    if (typeof value !== 'string') continue
    const max = TEXT_LIMITS[field]
    if (value.length > max) throw new QboTextTooLongError(field, value.length, max)
  }
}
