// QBO General Ledger report rows and the ids of the accounts every invoice and payment posts to.
import { toMoney, type Money } from '../../src/money.js'
import type { QboClient } from '../../src/qbo/client.js'

export interface GlRow {
  accountId: string
  amount: Money
  type: string
  num: string
  name: string
}

interface ReportRow {
  Header?: { ColData: { value: string; id?: string }[] }
  ColData?: { value: string }[]
  Rows?: { Row: ReportRow[] }
}

export async function generalLedger(
  client: QboClient,
  opts: { date: string; accountIds: string[] }
): Promise<GlRow[]> {
  const res = await client.request('GET', '/reports/GeneralLedger', {
    query: { start_date: opts.date, end_date: opts.date, account: opts.accountIds.join(',') },
  })
  const body = res.body as {
    Columns: { Column: { ColTitle: string }[] }
    Rows?: { Row: ReportRow[] }
  }
  const titles = body.Columns.Column.map((c) => c.ColTitle)
  const col = (title: string) => titles.indexOf(title)
  const [typeCol, numCol, nameCol, amountCol] = [
    col('Transaction Type'),
    col('Num'),
    col('Name'),
    col('Amount'),
  ]
  if ([typeCol, numCol, nameCol, amountCol].includes(-1)) {
    throw new Error(`unexpected GeneralLedger columns: ${titles.join(', ')}`)
  }
  const rows: GlRow[] = []
  for (const section of body.Rows?.Row ?? []) {
    const accountId = section.Header?.ColData[0]?.id
    if (!accountId) continue
    for (const r of section.Rows?.Row ?? []) {
      if (!r.ColData) continue
      rows.push({
        accountId,
        amount: toMoney(r.ColData[amountCol].value),
        type: r.ColData[typeCol].value,
        num: r.ColData[numCol].value,
        name: r.ColData[nameCol].value,
      })
    }
  }
  return rows
}

// A/R and Undeposited Funds are looked up by their QBO type and name
export async function postingAccountIds(
  client: QboClient
): Promise<{ receivable: string; undeposited: string }> {
  const one = async (where: string) => {
    const res = await client.query(`select Id from Account where ${where}`)
    const accounts = (res.body as { QueryResponse: { Account?: { Id: string }[] } }).QueryResponse
      .Account
    if (accounts?.length !== 1) {
      throw new Error(`expected exactly one account where ${where}, got ${accounts?.length ?? 0}`)
    }
    return accounts[0].Id
  }
  return {
    receivable: await one(`AccountType = 'Accounts Receivable'`),
    undeposited: await one(`Name = 'Undeposited Funds'`),
  }
}
