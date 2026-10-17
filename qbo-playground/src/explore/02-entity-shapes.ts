// Area 2: entity shapes and minimal valid bodies for Customer, Invoice, Payment; line
// validation rules; DocNumber, tax, currency, inactive customers.
import { client } from '../setup.js'
import { marker, show } from './lib.js'

const qbo = client()
const m = marker('02')
const err = (b: any) => b.Fault?.Error?.map((e: any) => `${e.code} ${e.Message} | ${e.Detail}`)

// --- Customer
const custRes = await qbo.request('POST', '/customer', { body: { DisplayName: `${m}-cust` } })
show('Customer: minimal create (DisplayName only)', custRes)
const cust = (custRes.body as any).Customer

show(
  'Customer: duplicate DisplayName',
  await qbo.request('POST', '/customer', { body: { DisplayName: `${m}-cust` } }),
  err
)
show(
  'Customer: duplicate DisplayName, different case',
  await qbo.request('POST', '/customer', { body: { DisplayName: `${m}-CUST` } }),
  (b) => err(b) ?? b.Customer.Id
)
show(
  'Customer: no DisplayName, GivenName only',
  await qbo.request('POST', '/customer', { body: { GivenName: `${m}-given` } }),
  (b) => err(b) ?? { Id: b.Customer.Id, DisplayName: b.Customer.DisplayName }
)
show(
  'Customer: delete operation',
  await qbo.request('POST', '/customer', {
    query: { operation: 'delete' },
    body: { Id: cust.Id, SyncToken: cust.SyncToken },
  }),
  err
)

// --- Invoice: minimal bodies and line rules
const inv = (label: string, body: object) =>
  qbo
    .request('POST', '/invoice', { body: { CustomerRef: { value: cust.Id }, ...body } })
    .then((res) => {
      show(label, res, (b) => err(b) ?? summarize(b.Invoice))
      return (res.body as any).Invoice
    })
const summarize = (i: any) => ({
  Id: i.Id,
  DocNumber: i.DocNumber,
  TxnDate: i.TxnDate,
  DueDate: i.DueDate,
  TotalAmt: i.TotalAmt,
  Balance: i.Balance,
  CurrencyRef: i.CurrencyRef,
  TxnTaxDetail: i.TxnTaxDetail,
  SalesTermRef: i.SalesTermRef,
  CustomerMemo: i.CustomerMemo,
  PrivateNote: i.PrivateNote?.length > 60 ? `<${i.PrivateNote.length} chars>` : i.PrivateNote,
  Line: i.Line.map((l: any) => ({
    Id: l.Id,
    DetailType: l.DetailType,
    Amount: l.Amount,
    Description: l.Description,
    detail: l.SalesItemLineDetail,
  })),
})

await inv('Invoice: one line, empty SalesItemLineDetail (no ItemRef)', {
  Line: [{ Amount: 100, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: {} }],
})
await inv('Invoice: SalesItemLineDetail with Qty only (no ItemRef)', {
  Line: [{ Amount: 100, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { Qty: 1 } }],
})
const minimal = await inv('Invoice: minimal (one line, Amount + ItemRef)', {
  Line: [
    {
      Amount: 100,
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: { ItemRef: { value: '1' } },
    },
  ],
})
console.log('full minimal invoice:\n' + JSON.stringify(minimal, null, 2))
await inv('Invoice: line without SalesItemLineDetail object', {
  Line: [{ Amount: 100, DetailType: 'SalesItemLineDetail' }],
})
await inv('Invoice: explicit DocNumber', {
  DocNumber: `${m}`.slice(-21),
  Line: [
    {
      Amount: 10,
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: { ItemRef: { value: '1' } },
    },
  ],
})
await inv('Invoice: DocNumber longer than 21 chars', {
  DocNumber: 'X'.repeat(22),
  Line: [
    {
      Amount: 10,
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: { ItemRef: { value: '1' } },
    },
  ],
})
await inv('Invoice: Qty*UnitPrice != Amount', {
  Line: [
    {
      Amount: 99,
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: { ItemRef: { value: '1' }, Qty: 2, UnitPrice: 50 },
    },
  ],
})
await inv('Invoice: Qty + UnitPrice consistent', {
  Line: [
    {
      Amount: 100,
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: { ItemRef: { value: '1' }, Qty: 2, UnitPrice: 50 },
    },
  ],
})
await inv('Invoice: Amount with 3 decimals (10.005)', {
  Line: [
    {
      Amount: 10.005,
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: { ItemRef: { value: '1' } },
    },
  ],
})
await inv('Invoice: negative line', {
  Line: [
    {
      Amount: 100,
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: { ItemRef: { value: '1' } },
    },
    {
      Amount: -30,
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: { ItemRef: { value: '1' } },
    },
  ],
})
await inv('Invoice: total negative', {
  Line: [
    {
      Amount: -30,
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: { ItemRef: { value: '1' } },
    },
  ],
})
await inv('Invoice: zero amount', {
  Line: [
    {
      Amount: 0,
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: { ItemRef: { value: '1' } },
    },
  ],
})
await inv('Invoice: DescriptionOnly line + item line', {
  Line: [
    { DetailType: 'DescriptionOnly', Description: 'just text', DescriptionLineDetail: {} },
    {
      Amount: 10,
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: { ItemRef: { value: '1' } },
    },
  ],
})
await inv('Invoice: only DescriptionOnly line', {
  Line: [{ DetailType: 'DescriptionOnly', Description: 'just text', DescriptionLineDetail: {} }],
})
await inv('Invoice: inventory item (Pump) without Qty', {
  Line: [
    {
      Amount: 15,
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: { ItemRef: { value: '11' } },
    },
  ],
})
await inv('Invoice: taxable service item (Concrete), no tax fields', {
  Line: [
    {
      Amount: 100,
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: { ItemRef: { value: '3' } },
    },
  ],
})
await inv('Invoice: taxable service item, line TaxCodeRef TAX', {
  Line: [
    {
      Amount: 100,
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: { ItemRef: { value: '3' }, TaxCodeRef: { value: 'TAX' } },
    },
  ],
})
await inv('Invoice: taxable service item, TAX + TxnTaxCodeRef California', {
  TxnTaxDetail: { TxnTaxCodeRef: { value: '2' } },
  Line: [
    {
      Amount: 100,
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: { ItemRef: { value: '3' }, TaxCodeRef: { value: 'TAX' } },
    },
  ],
})
await inv('Invoice: non-taxable item forced TAX + California', {
  TxnTaxDetail: { TxnTaxCodeRef: { value: '2' } },
  Line: [
    {
      Amount: 100,
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: { ItemRef: { value: '1' }, TaxCodeRef: { value: 'TAX' } },
    },
  ],
})
await inv('Invoice: taxable item, line TaxCodeRef NON + California', {
  TxnTaxDetail: { TxnTaxCodeRef: { value: '2' } },
  Line: [
    {
      Amount: 100,
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: { ItemRef: { value: '3' }, TaxCodeRef: { value: 'NON' } },
    },
  ],
})
await inv('Invoice: explicit dates + memo + private note', {
  TxnDate: '2026-01-15',
  DueDate: '2026-02-14',
  PrivateNote: `${m} private`,
  CustomerMemo: { value: 'memo for customer' },
  Line: [
    {
      Amount: 10,
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: { ItemRef: { value: '1' } },
    },
  ],
})
await inv('Invoice: DueDate before TxnDate', {
  TxnDate: '2026-02-15',
  DueDate: '2026-01-01',
  Line: [
    {
      Amount: 10,
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: { ItemRef: { value: '1' } },
    },
  ],
})
await inv('Invoice: CurrencyRef EUR (multicurrency off)', {
  CurrencyRef: { value: 'EUR' },
  Line: [
    {
      Amount: 10,
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: { ItemRef: { value: '1' } },
    },
  ],
})
await inv('Invoice: unknown ItemRef', {
  Line: [
    {
      Amount: 10,
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: { ItemRef: { value: '99999' } },
    },
  ],
})
await inv('Invoice: PrivateNote 4001 chars', {
  PrivateNote: 'n'.repeat(4001),
  Line: [
    {
      Amount: 10,
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: { ItemRef: { value: '1' } },
    },
  ],
})
await inv('Invoice: PrivateNote 4000 chars', {
  PrivateNote: 'n'.repeat(4000),
  Line: [
    {
      Amount: 10,
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: { ItemRef: { value: '1' } },
    },
  ],
})

// --- Payment: minimal, linked to the minimal invoice
const payRes = await qbo.request('POST', '/payment', {
  body: {
    CustomerRef: { value: cust.Id },
    TotalAmt: 40,
    Line: [{ Amount: 40, LinkedTxn: [{ TxnId: minimal.Id, TxnType: 'Invoice' }] }],
  },
})
show('Payment: minimal, linked to invoice', payRes)
show(
  'Payment: no lines (unapplied)',
  await qbo.request('POST', '/payment', { body: { CustomerRef: { value: cust.Id }, TotalAmt: 5 } }),
  (b) =>
    err(b) ?? {
      Id: b.Payment.Id,
      TotalAmt: b.Payment.TotalAmt,
      UnappliedAmt: b.Payment.UnappliedAmt,
      DepositToAccountRef: b.Payment.DepositToAccountRef,
      Line: b.Payment.Line,
    }
)
show('Invoice after 40 paid', await qbo.request('GET', `/invoice/${minimal.Id}`), (b) => ({
  TotalAmt: b.Invoice.TotalAmt,
  Balance: b.Invoice.Balance,
  LinkedTxn: b.Invoice.LinkedTxn,
  SyncToken: b.Invoice.SyncToken,
}))

// --- Inactive customer: deactivate, then query + invoice against it
const custNow = ((await qbo.request('GET', `/customer/${cust.Id}`)).body as any).Customer
const deact = await qbo.request('POST', '/customer', {
  body: { Id: cust.Id, SyncToken: custNow.SyncToken, sparse: true, Active: false },
})
show(
  'Customer: sparse update Active=false (with open balance)',
  deact,
  (b) =>
    err(b) ?? {
      Active: b.Customer.Active,
      DisplayName: b.Customer.DisplayName,
      Balance: b.Customer.Balance,
    }
)
const other = (await qbo.request('POST', '/customer', { body: { DisplayName: `${m}-cust2` } }))
  .body as any
const deact2 = await qbo.request('POST', '/customer', {
  body: { Id: other.Customer.Id, SyncToken: other.Customer.SyncToken, sparse: true, Active: false },
})
show(
  'Customer: sparse update Active=false (no balance)',
  deact2,
  (b) => err(b) ?? { Active: b.Customer.Active, DisplayName: b.Customer.DisplayName }
)
show(
  'Query inactive customer by default',
  await qbo.query(`select Id, Active from Customer where Id = '${other.Customer.Id}'`),
  (b) => b.QueryResponse
)
show(
  'Query with Active = false',
  await qbo.query(
    `select Id, Active from Customer where Active = false and Id = '${other.Customer.Id}'`
  ),
  (b) => b.QueryResponse
)
show(
  'GET inactive customer by id',
  await qbo.request('GET', `/customer/${other.Customer.Id}`),
  (b) => err(b) ?? { Active: b.Customer.Active }
)
show(
  'Invoice against inactive customer',
  await qbo.request('POST', '/invoice', {
    body: {
      CustomerRef: { value: other.Customer.Id },
      Line: [
        {
          Amount: 10,
          DetailType: 'SalesItemLineDetail',
          SalesItemLineDetail: { ItemRef: { value: '1' } },
        },
      ],
    },
  }),
  (b) => err(b) ?? b.Invoice.Id
)
show(
  'New customer reusing inactive DisplayName',
  await qbo.request('POST', '/customer', { body: { DisplayName: `${m}-cust2` } }),
  (b) => err(b) ?? b.Customer.Id
)
