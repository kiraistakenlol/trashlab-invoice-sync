# QuickBooks Online Accounting API - observed behaviour

<!-- last-updated: 2026-10-19 -->

How the QuickBooks Online (QBO) Accounting API v3 actually behaves, established by running
experiments against a sandbox company. It complements Intuit's reference documentation:
it records what the docs leave out, get wrong, or state only vaguely.

**Status tags.** Statements are **verified** (observed in the sandbox; evidence in
Appendix D) unless marked **docs** (taken from documentation, not observed; source linked).

**Coverage so far:** request conventions, errors, query language, Customer / Invoice /
Payment shapes, create and update semantics, `requestid` idempotency, void and delete,
payments and balances, change data capture, accounts / items / journal entries / GL
reports, throttling, token lifecycle, `/batch`, matching records and external ids,
webhooks, edits made in the QBO web UI. Partly covered: webhook delivery after repeated
failures and slow responses (14.4).

## Contents

1. Test environment
2. Request conventions
3. Errors
4. Query language
5. Entities: Customer, Invoice, Payment
6. Writes: create and update
7. Idempotency (`requestid`)
8. Void and delete
9. Payments and balances
10. Change data capture (CDC)
11. Accounts, items and the general ledger
12. Limits, tokens and batch
13. Finding records and storing external ids
14. Webhooks
15. Edits made in the QBO web UI
- A. Gotchas
- B. Minimal request bodies
- C. Open questions
- D. Evidence index

## 1. Test environment

Behaviour that depends on company settings was observed with these:

| Setting                        | Value                                                    |
|--------------------------------|----------------------------------------------------------|
| Environment                    | Sandbox, `https://sandbox-quickbooks.api.intuit.com`     |
| Company                        | "Sandbox Company US 28a6", realm `9341458506606758`, US  |
| Currency                       | USD; multicurrency **off**                               |
| Sales tax                      | **on**; tax code `2` "California" (rate `3`, 8 %); codes `TAX` / `NON` |
| Custom transaction numbers     | **off** (`SalesFormsPrefs.CustomTxnNumbers: false`)      |
| Payments                       | `AutoApplyPayments: true`, `AutoApplyCredit: true`       |
| Default terms                  | `3` "Net 30"                                             |
| Item `1` "Services"            | Service, non-taxable, income account `1` "Services"      |
| Account `4`                    | "Undeposited Funds" (Other Current Asset)                |
| Sandbox user (in messages)     | "Craig Carlson", user id `9341458506647607`              |
| Company time zone offset       | `-07:00` (as rendered in timestamps)                     |
| Initial data                   | 31 invoices, 29 customers, 18 items, 89 accounts         |

## 2. Request conventions

### 2.1 Base URL and minorversion

- Paths are `/v3/company/{realmId}/<entity>[/<id>]`, plus `/query`.
- **`minorversion` is never validated.** Every value tried returns HTTP 200 with no
  warning: none, `1`, `40`, `65`, `70`, `73`-`76`, `80`, `999`, `abc`.
- The top-level field sets of Invoice, Customer, Payment, Item, Account and CompanyInfo are
  identical for none / `1` / `75` / `999`. (Field *sets* only; values were not compared.)
- **docs:** since 2025-08-01, versions 1-74 are retired; a missing or lower value is served
  as 75 ([Intuit blog](https://blogs.intuit.com/?p=34635),
  [Codat notice](https://docs.codat.io/updates/250219-qbo-minor-versions-update)).
  Consistent with the above.

### 2.2 Response envelopes

| Kind        | Shape                                                                     |
|-------------|---------------------------------------------------------------------------|
| Read/write  | `{ "<Entity>": { ... }, "time": "<ISO>" }`                                |
| Query       | `{ "QueryResponse": { "<Entity>": [ ... ], "startPosition", "maxResults", "totalCount" }, "time" }` |
| Count       | `{ "QueryResponse": { "totalCount": 31 }, "time" }`                       |
| Empty query | `{ "QueryResponse": {}, "time" }` - no entity key, no counters            |
| Error       | `{ "Fault": { "Error": [ ... ], "type" }, "time" }` (see 3)               |

Every entity carries `Id` (string), `SyncToken` (string), `domain: "QBO"`, `sparse`
(boolean) and `MetaData`.

### 2.3 Timestamps and dates

- `MetaData.CreateTime` / `LastUpdatedTime`: ISO-8601 with the company offset, **whole
  seconds** (`2026-09-19T13:16:17-07:00`). Transactions also carry
  `MetaData.LastModifiedByRef` (user id).
- `TxnDate`, `DueDate`: plain dates (`2026-09-19`).
- Envelope `time`: ISO-8601 with milliseconds - except in 401 bodies, where it is epoch
  milliseconds (see 3.1).

## 3. Errors

### 3.1 Fault format

Almost every error is **HTTP 400** with `Fault.type: "ValidationFault"` - including
"object not found", which is **not** a 404. One request can return several errors:

```json
{ "Fault": { "Error": [
    { "Message": "Required param missing, need to supply the required value for the API",
      "Detail": "Required parameter Line is missing in the request", "code": "2020", "element": "Line" },
    { "Message": "CustomerRef is required", "Detail": "CustomerRef is missing in the request",
      "code": "6560", "element": "Invoice" } ],
  "type": "ValidationFault" },
  "time": "2026-10-16T06:15:02.927-07:00" }
```

`code` is a string; `element` is often present, sometimes empty.

**Exception:** `/cdc` with a missing parameter returns **HTTP 200** with a `Fault` body
(`type: "SystemFault"`, code `10000`) - check for `Fault` regardless of status.

An invalid or expired access token gives **HTTP 401 with a different, lowercase envelope**
and a `www-authenticate: Bearer realm="Intuit", error="invalid_token"` header:

```json
{ "fault": { "error": [{ "message": "message=AuthenticationFailed; errorCode=003200; statusCode=401",
  "detail": "Malformed bearer token: too short or too long", "code": "3200", "element": null }],
  "type": "AUTHENTICATION" },
  "time": 1792156503951, "warnings": null, "intuitObject": null, "queryResponse": null,
  "batchItemResponse": [], "cdcresponse": [], "...": "more null fields" }
```

### 3.2 Error codes observed

All HTTP 400 `ValidationFault` unless noted.

| code   | Message (abridged)                       | Observed when                                      |
|--------|------------------------------------------|----------------------------------------------------|
| `500`  | Unsupported Operation                    | unknown entity in path; `?operation=delete` on Customer or Account |
| `425`  | (empty body, `text/xml`; HTTP **425**)   | a request whose `requestid` is still being processed (see 7) |
| `610`  | Object Not Found                         | payment linking an unknown invoice id; GET by an id that doesn't exist or was deleted; deleting an already deleted invoice; updating or voiding a deleted invoice ("Another user has deleted this transaction") |
| `620`  | TxnID Cannot Be Linked                   | payment linking another customer's invoice         |
| `2010` | Request has invalid or unsupported property | malformed JSON body; unknown entity in `/cdc` `entities` |
| `2020` | Required param missing                   | no `Line`, empty `Line: []`, empty/missing `SalesItemLineDetail`; delete without `SyncToken`; sparse Payment update without `CustomerRef` |
| `2050` | String length ... Min:0 Max:N            | `DocNumber` > 21, `PrivateNote` > 4000             |
| `2500` | Invalid Reference Id                     | unknown `CustomerRef` / `ItemRef`                  |
| `2170` | Invalid Account.AccountType && Account.SubType | Account without, or with an unknown, `AccountType` |
| `2180` | Invalid Enumeration                      | Account name containing `:`                        |
| `2240` | Number out of range (Min:0 ...)          | negative Payment `TotalAmt`                        |
| `2300` | Amount on debits not equal to credits    | unbalanced JournalEntry (create or update)         |
| `1040` | Batch size exceeds allowed limit         | `/batch` with more than 30 items                   |
| `3001` | ThrottleExceeded (HTTP **429**, lowercase envelope) | too many concurrent requests or too high a rate (see 12.1) |
| `3200` | AuthenticationFailed (HTTP **401**)      | bad access token                                   |
| `4000` | Error parsing query                      | syntax error, `OR`, `BETWEEN`, negative number     |
| `4001` | Invalid query                            | unknown entity/property, `maxresults` 0 or > 1000; filtering on a non-queryable property ("property 'PrivateNote' is not queryable") |
| `5010` | Stale Object Error                       | update with a stale, future or missing `SyncToken` |
| `6000` | Business Validation Error                | invoice total < 0; `requestid` > 50 chars; `requestid` reused on another entity (see 7); invoice void without `SyncToken` ("never been saved"); Payment `?operation=void` (see 8.3); payment lines exceeding `TotalAmt`, or `TotalAmt` missing / 0 (see 9); JournalEntry with one line or an A/R line without a customer (see 11) |
| `6070` | Amount calculation incorrect             | `Amount` ≠ `Qty × UnitPrice`                       |
| `6220` | Delete List Has Balance Error            | deactivating a customer with an open balance       |
| `6240` | Duplicate Name Exists Error              | Customer `DisplayName` or Account `Name` already used |
| `6250` | Invalid Customer                         | transaction for an inactive customer               |
| `6520` | Missing Inventory Item Quantity          | inventory item line without `Qty`                  |
| `6560` | CustomerRef is required                  | invoice without `CustomerRef`                      |
| `10000` | System Failure Error: {0} (HTTP **200**, `SystemFault`) | `/cdc` without `changedSince` or without `entities` |

## 4. Query language

`GET /query?query=<sql>`. SQL-like, one entity per query, no joins.

**Syntax.** `select * | <fields> | count(*) from <Entity> [where ...] [orderby <field>
[asc|desc]] [startposition N] [maxresults N]`. Keywords, entity and property names are
case-insensitive (`SELECT * FROM invoice WHERE docnumber = '1001' ORDERBY Id` works).
`CompanyInfo` accepts only `select *`.

**Filters.**
- Operators: `=`, `!=`, `<`, `<=`, `>`, `>=`, `IN (...)`, `LIKE 'prefix%'`; conditions
  joined with `AND` only. `OR` and `BETWEEN` are parse errors (`4000`).
- Values are quoted strings, including numbers (`TotalAmt > '100'`, `Balance > '0'`).
  A quote inside a value is escaped with a backslash (`'O\'Brien'`); doubling it (`''`) is
  a parse error.
- String comparisons are case-insensitive (`DocNumber = 'm12-0001'` matches `M12-0001`).
- Not every property can be filtered: see 13.1.
- `Id IN (...)` skips unknown ids silently.
- Nested properties: `MetaData.LastUpdatedTime`, `MetaData.CreateTime`.
- Unknown property: with a quoted value gives a clear `4001 Property X not found`; with an
  unquoted number gives a misleading parse error ("expecting true/false").

**Timestamp filters work at whole seconds.** Milliseconds in the filter value are
truncated; offsets and `Z` are both honoured; a bare date works. Boundary record
`LastUpdatedTime = 2026-09-19T13:16:17-07:00`:

| Filter on `MetaData.LastUpdatedTime` | Matches |
|--------------------------------------|---------|
| `= t`, `>= t`, `<= t`                | yes     |
| `> t`, `< t`                         | no      |
| `>= t` / `> t` written in UTC (`Z`)  | yes / no |
| `> t - 1s`, `> t - 500ms`            | yes     |
| `>= t + 500ms`                       | **yes** (ms dropped) |
| `>= '2026-09-19'`                    | yes     |

**Paging and counts.**
- `maxresults` 1..1000 (`0` and `1001` -> `4001`). Default page size without `maxresults`:
  **docs** 100 (not observable - no entity here exceeds 89 rows).
- `startposition` is 1-based; `0` is served as 1; `-1` is a lexer error; past the end
  returns `QueryResponse: {}`.
- **`totalCount` is the number of rows in the returned page, not the total**, and is
  sometimes absent (seen with `Id IN (...)` on Account and `Active = false` on Customer).
  Only `select count(*)` returns a total.
- Without `orderby` the order is stable between calls and matched
  `LastUpdatedTime desc` here; not documented as guaranteed.

**Field lists.** Selecting specific fields returns objects with `sparse: true` that still
include some unrequested fields, and **`Line: []` / `LinkedTxn: []` regardless of the real
data** - an empty `Line` there doesn't mean the record has no lines.

**Inactive records** (`Active = false`, e.g. Customer) are excluded unless the query
filters on `Active = false`; GET by id still returns them. `Active IN (true, false)` is
accepted by the query parser.

## 5. Entities

### 5.1 Customer

- **Minimal create:** `{ "DisplayName": "..." }`. `GivenName` alone also works; it becomes
  the `DisplayName`. Defaults: `Taxable: true`, `DefaultTaxCodeRef` = company tax code,
  `PreferredDeliveryMethod: "Print"`, `CurrencyRef` = home currency.
- **`DisplayName` is unique, case-insensitively** (`6240`). `FullyQualifiedName` and
  `PrintOnCheckName` mirror it; sub-customers (`Job: true`, `ParentRef`) show as
  `Parent:Child`.
- **No delete** (`?operation=delete` -> `500 Unsupported Operation`). Deactivate with a
  sparse update `Active: false`:
  - refused while the customer has a non-zero balance (`6220`);
  - on success the customer is **renamed `"<DisplayName> (deleted)"`**, and the original
    name can be used by a new customer;
  - inactive customers can't receive new or edited transactions (`6250` "The customer you
    have specified has been deleted").
- `Balance` / `BalanceWithJobs` are read-only open-balance totals.

**Items.** Deactivating an Item (sparse `Active: false`) renames it `"<Name> (deleted)"`
like a Customer; a new Item with the original name is then created without `6240`.
The freed name can take a short while to become available: a create right after the
deactivation can still fail with `6240` (observed for an Account, 2026-10-19), so the same
holds for customers and items until shown otherwise.

### 5.2 Invoice

**Minimal create:** `CustomerRef` plus one `Line` with `Amount`, `DetailType:
"SalesItemLineDetail"` and a **non-empty** `SalesItemLineDetail`. Full response of a
minimal create, trimmed of the `AllowOnline*` flags:

```json
{ "Id": "157", "SyncToken": "0", "DocNumber": "1049", "TxnDate": "2026-10-16", "DueDate": "2026-11-15",
  "CustomerRef": { "value": "60", "name": "EXPLORE-02-...-cust" },
  "CurrencyRef": { "value": "USD", "name": "United States Dollar" },
  "Line": [
    { "Id": "1", "LineNum": 1, "Amount": 100, "DetailType": "SalesItemLineDetail",
      "SalesItemLineDetail": { "ItemRef": { "value": "1", "name": "Services" },
        "ItemAccountRef": { "value": "1", "name": "Services" }, "TaxCodeRef": { "value": "NON" } },
      "CustomExtensions": [] },
    { "Amount": 100, "DetailType": "SubTotalLineDetail", "SubTotalLineDetail": {} } ],
  "TxnTaxDetail": { "TotalTax": 0 }, "TotalAmt": 100, "Balance": 100, "LinkedTxn": [],
  "CustomField": [], "ShipFromAddr": { "...": "company address" },
  "PrintStatus": "NeedToPrint", "EmailStatus": "NotSet", "ApplyTaxAfterDiscount": false,
  "MetaData": { "CreateTime": "...", "LastUpdatedTime": "...", "LastModifiedByRef": { "value": "9341458506647607" } } }
```

**Defaults on create.**
- `TxnDate` = today; `DueDate` from the company's default terms (Net 30).
- `DocNumber` auto-assigned from a company sequence (`1038`, `1039`, ...) when omitted.
- API-created invoices get `AllowOnlinePayment`, `AllowOnlineCreditCardPayment`,
  `AllowOnlineACHPayment: true` (pre-existing ones had `false`).
- **A `SubTotalLineDetail` line (no `Id`) is appended** to every invoice.

**Header fields.**
- `DocNumber`: max 21 chars; may be supplied even with custom transaction numbers off;
  **duplicates are accepted** on create and update, with no error or warning.
- `PrivateNote`: internal memo, max 4000 chars. `CustomerMemo: { value }`: shown to the
  customer, **max 1000 chars**. Both round-trip unchanged.
- Text limits of every field the sync writes (`explore/14-text-limits.ts`, binary search;
  one char over -> 400 `2050` "Max:N supported. Supplied length:N+1"; nothing is cut
  silently): `CustomerMemo` 1000, line `Description` 4000, Customer `DisplayName` 500,
  Item `Name` 100, Account `Name` 100, `DocNumber` 21.
- `DueDate` earlier than `TxnDate` is accepted as sent.
- `CurrencyRef` other than the home currency (`EUR`) is **silently ignored** when
  multicurrency is off - the invoice is stored in USD.
- Read-only / computed: `TotalAmt`, `Balance`, `TxnTaxDetail.TotalTax`, `LinkedTxn`.

**Lines.**
- `DetailType` values seen: `SalesItemLineDetail`, `DescriptionOnly` (text only, no
  amount; needs `DescriptionLineDetail: {}`), `SubTotalLineDetail` (generated).
- `SalesItemLineDetail: {}` or missing -> `2020`. Non-empty but without `ItemRef`
  (e.g. `{ "Qty": 1 }`) -> **silently uses item `1` "Services"**.
- `Amount` must equal `Qty × UnitPrice` when both are sent (`6070`). Either may be omitted.
- Amounts are **rounded to cents** silently (`10.005` -> `10.01`).
- Negative lines are allowed as long as the invoice total is ≥ 0 (`6000` otherwise);
  zero-total invoices and invoices with only `DescriptionOnly` lines are allowed.
- Inventory items require `Qty` (`6520`).
- Each line reports `ItemAccountRef` (the item's income account).

**Sales tax** (company with sales tax on):
- **Tax is not applied by default on API creates.** The customer's `DefaultTaxCodeRef`
  and the item's `Taxable` flag are ignored: lines get `TaxCodeRef: NON` and
  `TotalTax: 0`.
- Tax is computed only when the body sends **both** line `TaxCodeRef: TAX` and
  `TxnTaxDetail.TxnTaxCodeRef` - then QBO computes it (100 at 8 % -> `TotalTax` 8,
  `TotalAmt` 108, one `TaxLine` with `TaxRateRef`, `TaxPercent`, `NetAmountTaxable`). This
  also taxes items flagged non-taxable.
- Line `TAX` without `TxnTaxCodeRef` -> tax 0. Line `NON` with `TxnTaxCodeRef` -> tax 0
  and `TxnTaxCodeRef` dropped.
- **Once an invoice carries `TxnTaxCodeRef`** (created with tax, or saved in the QBO UI at
  any time, see 15), an update that sends `Line` without `TxnTaxDetail.TxnTaxCodeRef` is
  rejected: `6000` "QuickBooks encountered an error while calculating tax. Try reselecting
  the tax rate ...", with `TAX` or `NON` lines, with or without line Ids. Updates without
  `Line` (e.g. `PrivateNote`) succeed. Sending `TxnTaxCodeRef` with the lines succeeds:
  with `TAX` lines tax is recomputed (200 -> tax 16, total 216); with `NON` lines tax
  becomes 0 and `TxnTaxCodeRef` is dropped.

| Body variation                                   | Result |
|--------------------------------------------------|--------|
| `SalesItemLineDetail: {}` or missing             | 400 `2020` |
| `SalesItemLineDetail: { Qty: 1 }`                | 200, `ItemRef` = 1 "Services" |
| `DocNumber` 21 / 22 chars                        | 200 / 400 `2050` |
| `Qty 2 × UnitPrice 50`, `Amount 99`              | 400 `6070` |
| `Amount 10.005`                                  | 200, stored `10.01` |
| lines `100` and `-30`                            | 200, total 70 |
| only line `-30`                                  | 400 `6000` |
| `Amount 0`; only a `DescriptionOnly` line        | 200, total 0 |
| inventory item without `Qty`                     | 400 `6520` |
| taxable item, no tax fields                      | 200, `NON`, tax 0 |
| taxable item, line `TAX` only                    | 200, `TAX`, tax 0 |
| taxable item, line `TAX` + `TxnTaxCodeRef 2`     | 200, tax 8, total 108 |
| non-taxable item, line `TAX` + `TxnTaxCodeRef 2` | 200, tax 8 |
| taxable item, line `NON` + `TxnTaxCodeRef 2`     | 200, tax 0 |
| update of a taxed invoice: `Line` without `TxnTaxCodeRef` | 400 `6000` |
| update of a taxed invoice: `Line` + `TxnTaxCodeRef 2` | 200, tax recomputed (`NON`: tax 0, code dropped) |
| `DueDate` < `TxnDate`                            | 200, stored as sent |
| `CurrencyRef EUR`                                | 200, stored as USD |
| unknown `ItemRef`                                | 400 `2500` |
| `PrivateNote` 4000 / 4001 chars                  | 200 / 400 `2050` |
| `CustomerMemo` 1000 / 1001 chars                 | 200 / 400 `2050` |
| line `Description` 4000 / 4001 chars             | 200 / 400 `2050` |

### 5.3 Payment

- **Minimal create:** `{ CustomerRef, TotalAmt, Line: [{ Amount, LinkedTxn: [{ TxnId,
  TxnType: "Invoice" }] }] }`. `DepositToAccountRef` defaults to "Undeposited Funds".
- Without `Line` the payment is accepted as fully unapplied: `UnappliedAmt = TotalAmt`,
  `Line: []`.
- Response lines include a `LineEx` blob (serialised JAXB name/value pairs: `txnId`,
  `txnOpenBalance`, `txnReferenceNumber`) - informational noise.
- **Applying a payment changes the invoice:** `Balance` drops by the amount, the invoice's
  `LinkedTxn` gains `{ TxnId: <payment>, TxnType: "Payment" }`, and **the invoice's
  `SyncToken` increments**.
- Sparse Payment updates still require `CustomerRef` (`2020` without it).
- How payments affect balances, and the cases where QBO applies or unapplies them on its
  own: section 9.

## 6. Writes: create and update

Create and update are both `POST /<entity>`; an update carries `Id` and `SyncToken`. The
response holds the full resulting entity.

### 6.1 SyncToken (optimistic concurrency)

- An update must carry the current `SyncToken`. A stale, future or missing token ->
  **`5010` Stale Object Error**, `element: ""`, message
  `"You and <user> were working on this at the same time. <user> finished before you did,
  so your work was not saved."`
- Of two concurrent updates sent with the same token, exactly one succeeds; the other gets
  `5010`.
- String (`"1"`) and numeric (`1`) tokens are both accepted.
- **Reads are consistent with writes:** a GET and a query sent right after an update
  returned the token that update returned (5 of 5), and no later change appeared on its
  own.
- **`SyncToken` and `LastUpdatedTime` change only on a real change.** These return 200 with
  the token unchanged: a sparse update with no fields; a full update resending the GET body
  unchanged; resending the `SubTotalLineDetail` line; `CustomerMemo: null`;
  `DocNumber: ""`.

### 6.2 Sparse vs full update

- **Sparse** (`"sparse": true`): only the fields sent change - **except `Line`: when
  present it replaces the whole line list**, so lines not sent are deleted.
- **Full** (no `sparse`): every omitted writable field is reset - `PrivateNote`,
  `CustomerMemo`, `BillEmail` cleared; `DueDate` back to the terms default; **`TxnDate`
  reset to today**. `DocNumber` is kept.
- Clearing: `""` clears a string field (`PrivateNote`); `null` is ignored;
  `DocNumber: ""` is ignored (DocNumber cannot be cleared).
- `CustomerRef` can be changed by update (tested on an invoice without payments).

### 6.3 Lines on update

- Lines sent with their `Id` are updated in place.
- Lines sent without `Id`, **or with an unknown `Id`** (e.g. `99`, no error), are added
  with a new Id = highest Id ever used on the invoice + 1. **Line Ids are never reused**
  after a line is deleted.
- Reordering keeps Ids and renumbers `LineNum`.
- Replacing all lines with new ones (no Ids) on a partly paid invoice keeps the payment
  applied: 100 paid 30, lines resent unchanged -> new line Ids, `Balance` 70; raised to
  110 -> `Balance` 80, the payment still linked.
- `Line: []` is rejected (`2020`).

Sequence on one invoice (`Id:LineNum:Description`):

| Step                                              | SyncToken | Lines after          |
|---------------------------------------------------|-----------|----------------------|
| create A 10, B 20, C 30                           | 0         | 1:1:A, 2:2:B, 3:3:C  |
| sparse no-op; full no-op                          | 0, 0      | unchanged            |
| sparse `PrivateNote`                              | +1        | unchanged            |
| sparse `PrivateNote: ""`                          | +1        | (note cleared)       |
| sparse `CustomerMemo: null`                       | unchanged | (memo kept)          |
| sparse `Line: [line 2 -> 25]`                     | +1        | **2:1:B2 only**      |
| full with only Id, SyncToken, CustomerRef, Line   | +1        | memo, email cleared; DueDate default |
| full: line 2 dropped, new line D                  | +1        | 4:1:D                |
| full: + new line E                                | +1        | 4:1:D, 5:2:E         |
| full: + line with unknown Id 99                   | +1        | ..., **6**:3:F       |
| full: reversed order                              | +1        | 6:1:F, 5:2:E, 4:3:D  |
| full: resend incl. SubTotal line                  | unchanged |                      |
| full: `Line: []`                                  | 400 `2020`|                      |

### 6.4 Atomicity

A write is all-or-nothing: an update with one valid change (`PrivateNote`) and one invalid
change (unknown `ItemRef`) is rejected with `2500`, and the record is unchanged.

## 7. Idempotency (`requestid`)

Writes accept a `requestid` query parameter (`POST /invoice?requestid=<key>`). The server
remembers the **response** of a successful request under that key and returns it again for
any later request with the same key.

- **Replay returns the stored response verbatim** - HTTP 200, same body, including the
  original envelope `time`. Nothing is written. There is no header or field marking it as
  a replay; an envelope `time` older than the request is the only sign.
- **The body of the replay is not compared.** Same key with a different body (other
  `DocNumber`, other amount) returns the first response; the new body is silently
  dropped.
- **The stored response is a snapshot.** Replaying a create after the record was updated,
  or even deleted, returns the original `SyncToken 0` body, not the current state.
- **Works for every write tried:** Customer create, Invoice create, sparse update, delete
  (`?operation=delete`), Payment create. Replaying an update whose `SyncToken` has gone
  stale returns the stored 200; the same update without a key gets `5010`. Replaying a
  delete returns the stored `status: "Deleted"`; without a key it gets `610`. Replaying a
  payment does not apply it twice.
- **Concurrent requests with one key:** the first is processed; the others get **HTTP 425
  (Too Early)** with an empty body (`content-type: text/xml`, no `Retry-After`). Exactly one
  record is created.
- **Failed requests are not remembered.** A create rejected with `2500`, then resent with
  a corrected body and the same key, is processed normally.
- **A key is scoped to an entity type, not to a record or an operation.** Within one type
  any later request with the key gets the stored response, whatever it targets: an update
  of invoice B sent with the key of an update of invoice A returned A's response and left
  B unchanged; an update of invoice A sent with the key of an invoice create returned the
  created invoice. Only the returned `Id` shows that the request was not applied.
- Reusing a key on another entity type (an invoice-create key for a customer create)
  gives `6000` "An unexpected error occurred ... Please wait a few minutes and try again"
  - misleading, retrying does not help.
- **Length: at most 50 characters** (51 -> `6000` "You cannot enter more than 50
  characters in the request_id field"). A UUID (36) fits.
- **Client timeout, then retry:** a create aborted by the client (timeouts of 1, 50, 150
  and 300 ms, all with one key) still created the invoice server-side once; a retry with
  the same key returned that invoice. One record in total.
- **Without a key, a retried create duplicates** (two identical keyless creates -> two
  invoices with the same `DocNumber`).
- **Retention:** a key was still honoured 27 minutes after first use (replayed at 2 and
  27 min, same stored response). Longer retention not measured.

| Request                                                       | Result |
|---------------------------------------------------------------|--------|
| create, key A; again, key A, same body                        | 200, same `Id`, same body |
| create, key A, different body                                 | 200, first response; body ignored |
| create on another entity, key A                               | 400 `6000` |
| update of invoice B with the key of an update of invoice A    | 200, A's response; B unchanged |
| update of invoice A with the key of another invoice's create  | 200, the create response; A unchanged |
| update, key C; again, key C (token now stale)                 | 200, 200 (stored) |
| same update, no key                                           | 400 `5010` |
| delete, key E; again, key E; again, no key                    | 200, 200 (stored), 400 `610` |
| payment, key D; again, key D                                  | 200, 200; applied once |
| 5 concurrent creates, one key                                 | one 200, four 425; one record |
| create rejected (`2500`), key F; valid body, key F            | 400, then 200 (created) |
| key of 50 / 51 chars                                          | 200 / 400 `6000` |

## 8. Void and delete

### 8.1 Invoice void

`POST /invoice?operation=void` with `{ Id, SyncToken }`.

- **Effect:** every line's `Amount` becomes 0 (`Qty` / `UnitPrice` removed; lines and their
  Ids kept), `TotalAmt` and `Balance` become 0, `PrivateNote` is prefixed `"Voided - "`,
  `SyncToken` increments. Linked payments are **unlinked** (`LinkedTxn: []`) and become
  unapplied (`UnappliedAmt` = their amount, `Line: []`).
- **No void flag.** (Webhooks do report the operation as `Void`, see 14.3.) The response,
  GET and query carry no status field; compared field by
  field with a regular zero-amount invoice, a voided invoice differs **only by the
  `"Voided - "` prefix in `PrivateNote`** - which any later update can overwrite.
- It stays readable by GET and is returned by queries.
- **Not final:** voiding again succeeds (prefix doubled to `"Voided - Voided - ..."`,
  `SyncToken` +1); a sparse update can change its `PrivateNote` or give it new lines with
  a non-zero total, which turns it back into an ordinary open invoice. There is no
  "unvoid" operation.
- A voided invoice can be deleted.
- Checks: missing `SyncToken` -> `6000` "You can't void this transaction because it has
  never been saved"; wrong `SyncToken` -> `5010`.

### 8.2 Invoice delete

`POST /invoice?operation=delete` with `{ Id, SyncToken }`. Response:
`{ "Invoice": { "domain": "QBO", "status": "Deleted", "Id": "199" }, "time" }`.

- **`SyncToken` must be present but is not checked:** a stale (`0` when current is `1`)
  or made-up (`9`) token deletes the invoice. Missing -> `2020`.
- Afterwards: GET -> `610`; queries no longer return it (`QueryResponse: {}`); update and
  void -> `610` "Another user has deleted this transaction"; delete again -> `610`.
- Allowed for a partially paid invoice: the payments are unlinked and become unapplied
  (and may then attach to the customer's next invoice, see 9.2).
- Ids are not reused (deleted `199`, next new invoice `200`).

### 8.3 Payment void and delete

- **Void:** `POST /payment?operation=update&include=void` with `{ Id, SyncToken, sparse:
  true }`. The payment keeps its Id, gets `TotalAmt: 0`, `UnappliedAmt: 0`, `Line: []`,
  `PrivateNote: "Voided"`; the invoice it paid regains the amount (`Balance` back to the
  total, `LinkedTxn` loses it, `SyncToken` +1). The original amount is no longer on the
  record.
- `?operation=void` on a Payment fails: `6000` "You can't void this credit card amount
  because this transaction doesn't have an outstanding credit card amount".
- A voided payment can be revived by a sparse update with `CustomerRef`, `TotalAmt` and
  `Line` (it applies to the invoice again).
- **Delete:** `POST /payment?operation=delete` with `{ Id, SyncToken }`; response
  `{ "Payment": { "status": "Deleted", "Id" } }`. The invoice regains the amount and loses
  the `LinkedTxn`.

### 8.4 Editing a paid or partially paid invoice

- Invoice 100 paid 60, lines changed to 50: accepted. `TotalAmt` 50, `Balance` 0; the
  payment's line to the invoice shrinks to 50 and the rest becomes unapplied
  (`UnappliedAmt: 10`). No error or warning. The payment's `SyncToken` bumps and CDC
  returns it in its new state.

## 9. Payments and balances

### 9.1 Applying payments

- **`Balance` is the only payment status on an invoice.** No paid / partially-paid field
  exists (`PrintStatus`, `EmailStatus` are about delivery). Paid = `Balance` 0, partly
  paid = `0 < Balance < TotalAmt`. Each applied payment adds a `LinkedTxn` entry and bumps
  the invoice's `SyncToken`.
- Partial payments add up: 100 paid 30, 50, 20 -> `Balance` 70, 20, 0; `LinkedTxn` lists
  all three payments.
- **Over-application is clipped silently.** A line of 120 on an invoice with balance 100
  is stored as 100 applied plus `UnappliedAmt: 20`. A payment against an invoice with
  balance 0 (fully paid, or voided) is accepted and stored fully unapplied (`Line: []`).
- `TotalAmt` greater than the applied lines -> the rest is `UnappliedAmt`.
- One payment can be applied to several invoices, one `Line` per invoice (100 split 60 /
  40 pays both). A single `Line` carrying two `LinkedTxn` entries is accepted but **applies
  to neither** - the payment is stored fully unapplied.
- Rejected: lines exceeding `TotalAmt`, or `TotalAmt` missing (`6000` "The Amount
  Received (plus credits) can't be less than the selected charges"); `TotalAmt: 0`
  (`6000` "Enter a transaction amount"); negative `TotalAmt` (`2240`); an invoice of
  another customer (`620` "TxnID Cannot Be Linked"); an unknown invoice id (`610`).

### 9.2 Balances that change without a payment write

Company setting `AutoApplyPayments: true`. A payment's unapplied amount stays attached to
the customer, and QBO moves it on its own:

- **Unapplied credit is applied to the customer's invoices automatically:**
  - on **create**: a customer with an unapplied payment of 30 gets a new invoice of 100;
    the create response already shows `Balance` 70, a `LinkedTxn` to the payment and
    `SyncToken: "1"`;
  - on **update** that raises the open balance: a fully paid invoice raised from 100 to
    120, with 10 unapplied credit present, comes back with `Balance` 10 and `SyncToken`
    **+2** (3 -> 5).
- **Payments are unapplied automatically** (they become unapplied credit) when the invoice
  is voided or deleted (see 8), when its total is reduced below the amount paid (see
  8.4), and when its **`CustomerRef` is changed**: the payment stays with the old customer,
  fully unapplied, and the invoice's `Balance` returns to its total.
- Editing a payment replaces its lines: an invoice whose line is dropped regains the amount
  and loses the `LinkedTxn`; a reduced line raises the invoice balance by the difference.
  Payment updates use `SyncToken` like invoices (`5010` on stale).

| Scenario (fresh customer each)                   | Invoice after              | Payment after |
|--------------------------------------------------|----------------------------|---------------|
| invoice 100; pay 30, 50, 20                      | Balance 70, 20, 0          | applied       |
| pay 10 more on the paid invoice                  | unchanged                  | 10 unapplied  |
| line 120 on balance 100                          | Balance 0                  | 100 applied, 20 unapplied |
| one payment, lines 60 + 40 over two invoices     | both Balance 0             | applied       |
| one line with two `LinkedTxn`                    | unchanged                  | fully unapplied |
| payment edited 100 -> 70 (60 + 10)               | 2nd invoice Balance 30     | applied       |
| payment edited, 2nd invoice line dropped         | 2nd invoice Balance 40, `LinkedTxn: []` | applied to 1st only |
| partially paid invoice moved to another customer | Balance 100, `LinkedTxn: []` | fully unapplied, old customer |
| unapplied 30, then new invoice 100               | create returns Balance 70, `SyncToken 1` | applied |
| unapplied 10, paid invoice raised 100 -> 120     | Balance 10, `SyncToken` +2 | applied       |

## 10. Change data capture (CDC)

`GET /cdc?entities=Invoice,Payment,Customer&changedSince=<ISO>` returns the records of the
listed entities changed after the given time.

**Shape.**

```json
{ "CDCResponse": [{ "QueryResponse": [
    { "Payment": [ ... ], "startPosition": 1, "maxResults": 22, "totalCount": 22 },
    { "Invoice": [ ... ], "startPosition": 1, "maxResults": 71, "totalCount": 71 },
    { "Customer": [ ... ], "startPosition": 1, "maxResults": 26 } ] }],
  "time": "..." }
```

- One `QueryResponse` group per entity, not necessarily in the requested order; an entity
  with no changes is an empty group `{}`. `totalCount` is sometimes absent (as in 4).
- **One entry per record, in its current state** - not one per change. A record updated
  several times appears once (72 entries, 72 unique ids). Intermediate states are not
  available.
- Live records are full entities, the same as GET (plus a `FreeFormAddress` flag).
- **Deleted records** appear as a stub: `{ "domain": "QBO", "status": "Deleted", "Id":
  "182", "MetaData": { "LastUpdatedTime": "..." } }`. This is the only `status` value seen;
  live records have no `status`.
- **Voided invoices are not marked**: they come back as ordinary records (`TotalAmt` 0,
  `PrivateNote` "Voided - ...", no `status`), the same as in GET (8.1).
- Inactive customers are included (`Active: false`, renamed "(deleted)") - unlike queries,
  which hide them (4).
- Order: within an entity, live records by `LastUpdatedTime` ascending, then the deleted
  stubs.
- Records change without a write to them and show up in CDC: Accounts (A/R, Undeposited
  Funds, sales tax payable) whenever postings change their `CurrentBalance`; invoices whose
  payments QBO applied or unapplied (9.2).

**Parameters.**
- `changedSince` is **exclusive**: a record with `LastUpdatedTime` exactly `t` is not
  returned for `changedSince = t` (nor for `t + 500 ms`), but is for `t - 1 s`. Accepts
  `Z`, an offset, or a bare date.
- Look-back: `changedSince` up to 365 days ago returns 200 without error. **docs:** limited
  to the last 30 days; not observable here (all sandbox data is younger than 30 days).
- **docs:** at most 1,000 objects per entity per response; not observed (not reached).
- `entities` is case-insensitive (`invoice` works); an unknown entity -> `2010`. A
  `changedSince` in the future returns empty groups.
- Missing `changedSince` or `entities` -> HTTP 200 with `SystemFault` `10000` (see 3.1).

**Latency.** A create was visible in CDC 0.4 s after the write returned; a delete 0.35 s
after.

## 11. Accounts, items and the general ledger

### 11.1 Accounts

- `Account`: `Name`, `FullyQualifiedName` (`Parent:Child` for sub-accounts),
  `Classification` (Asset, Liability, Equity, Revenue, Expense), `AccountType`,
  `AccountSubType`, `Active`, `CurrentBalance`, `CurrentBalanceWithSubAccounts`. Ids of
  created accounts are large (`1150040000`), unlike pre-existing ones (`1`-`90`).
- This company has one A/R account (`84` "Accounts Receivable (A/R)"), "Undeposited Funds"
  (`4`), 20 Income accounts, 44 Expense accounts (89 in total).
- **Minimal create:** `{ "Name": "...", "AccountType": "Income" }` -> `AccountSubType`
  defaults (`OtherPrimaryIncome`). Name unique (`6240`), no `:` (`2180`); type missing or
  unknown -> `2170`.
- **No delete** (`500`). Deactivate with a sparse update `Active: false` (tested with
  `Name` included); like customers, the account is **renamed `"<Name> (deleted)"`**. Reusing the original
  name can fail with `6240` for a short time after the deactivation.
- `CurrentBalance` is maintained for balance-sheet accounts (A/R, Undeposited Funds) and
  bumps their `LastUpdatedTime`; it stayed `0` for an Income account that had postings.

### 11.2 How invoices and payments post

- An invoice line posts to the **item's `IncomeAccountRef`** (reported on the line as
  `ItemAccountRef`); the invoice total posts to A/R. Items: `Service` items have only an
  income account; `Inventory` items also have expense (COGS) and asset accounts.
- A payment moves the amount from A/R to `DepositToAccountRef` (default Undeposited Funds).
- The account is fixed by the item: there is no per-line account field on a sales line.
  To post to a specific account, create an item for it (`POST /item` with `Name`,
  `Type: "Service"`, `IncomeAccountRef`).
- Verified through the GeneralLedger report: invoice I09 for 123.45 -> A/R +123.45 and the
  item's income account +123.45; payment 23.45 -> A/R -23.45, Undeposited Funds +23.45.

### 11.3 Reports

- `GET /reports/GeneralLedger?start_date=&end_date=&account=<id,id>`: per account a
  `Header` row, transaction rows (`Date | Transaction Type | Num | Name | Memo/Description
  | Split | Amount | Balance`) and a `Summary` row. `Header.Option` `NoReportData` says
  whether anything matched. Accrual basis by default.
- `GET /reports/TrialBalance?start_date=&end_date=`: one row per account
  (`Account | Debit | Credit`) plus a `TOTAL` row where both sides are equal.
- Reports return cell values as strings in nested `Rows.Row[]` with `ColData[].value`; they
  are a read-only view and reflect writes immediately.

### 11.4 JournalEntry

- **Minimal create:** at least two lines, `DetailType: "JournalEntryLineDetail"`,
  `JournalEntryLineDetail: { PostingType: "Debit" | "Credit", AccountRef }`, debits =
  credits.
- Rejected: unbalanced (`2300`, also on update); a single line (`6000` "Fill out at least
  two detail lines"); a line on A/R without `Entity` (`6000` "When you use Accounts
  Receivable, you must choose a customer"). With `Entity: { Type: "Customer", EntityRef }`
  the A/R line **changes the customer's `Balance`** (100 open -> 115 after a 15 debit).
- Response: line Ids start at `"0"`; `TotalAmt` is `0` (not the posted amount);
  `Adjustment: false`.
- Update with `SyncToken` like other transactions (sparse `Line` replaces lines).
- **`?operation=void` is a silent no-op:** HTTP 200 with `{ "BatchItemResponse": [] }` and
  the entry unchanged (`SyncToken`, amounts). Delete works: `{ "JournalEntry": { "status":
  "Deleted", "Id" } }`.

### 11.5 In CDC

Account, Item and JournalEntry are supported by `/cdc`: a new item, a deleted journal entry
(stub), the created and the deactivated account, and every balance-sheet account whose
balance changed all appeared. One pre-existing sandbox account (`41` "Mastercard") has a
`LastUpdatedTime` in the future (`2026-11-19`) and therefore appears in every CDC window.

## 12. Limits, tokens and batch

### 12.1 Throttling

- **docs:** 500 requests/min per realm, 10 requests/s per realm and app, batch requests 40
  /min; a 429 suggests waiting 60 s
  ([Intuit: API call limits and throttles](https://developer.intuit.com/app/developer/qbo/docs/learn/limits-and-throttles);
  read through a search summary, the page itself didn't render for the fetch).
- **Observed, consistent with ~10 requests/s:** after a rest, bursts of 5, 8, 10 and 12
  parallel requests all succeeded (each burst took ~1 s); 15 gave 12 × 200 + 3 × 429, 20
  gave 12 + 8. The excess is refused immediately, not queued. Sequential requests
  (~3/s, ~170/min) were never throttled; four parallel workers (~12/s attempted) got 11 %
  429s.
- A 429 uses the lowercase envelope (like 401) with `time` in epoch ms and a
  `retry-after: 1` header:

```json
{ "fault": { "error": [{ "message": "message=ThrottleExceeded; errorCode=003001; statusCode=429",
    "detail": "The request limit was reached.  Try again later", "code": "3001",
    "element": null, "throttle_plan_name": "Default" }], "type": "SERVICE" },
  "time": 1792158508633, "batchItemResponse": [], "cdcresponse": [], "...": "more null fields" }
```

- Recovery is fast: after a burst of 429s, requests succeeded again within ~3 s (the docs'
  60 s is conservative here).

### 12.2 OAuth tokens

- Access tokens live **60 minutes**; refresh tokens **~101 days** (from
  `x_refresh_token_expires_in`).
- **Refreshing did not rotate the refresh token** here: two refreshes in a row returned new
  access tokens and the same refresh token, and the original refresh token kept working.
  The token response always carries a `refresh_token`, so a client that persists it on
  every refresh handles rotation whenever it does happen (not observed within this run).
- Earlier access tokens stay valid after a refresh (until they expire).
- An invalid refresh token -> HTTP 400 from the token endpoint
  `{"error":"invalid_grant","error_description":"Incorrect or invalid refresh token"}`.
- An invalid access token -> 401 / `3200` (see 3.1).

### 12.3 Batch

`POST /batch` with `{ "BatchItemRequest": [ { "bId", "operation": "create" | "update" |
"delete", "<Entity>": { ... } } | { "bId", "Query": "<sql>" } ] }`.

- Response: HTTP 200, `{ "BatchItemResponse": [ { "bId", "<Entity>" | "Fault" |
  "QueryResponse" } ] }` - one entry per item, matched by `bId`.
- **Items are independent, not a transaction:** a valid create succeeded next to an
  invalid one (`2500` in that item's `Fault`) - partial success inside a 200.
- At most **30 items** (31 -> `1040`).

## 13. Finding records and storing external ids

### 13.1 Queryable fields

| Entity   | Filterable (verified)                                                | Not queryable (`4001`) |
|----------|----------------------------------------------------------------------|------------------------|
| Invoice  | `Id`, `DocNumber` (`=`, `LIKE`), `CustomerRef`, `TxnDate`, `DueDate`, `TotalAmt`, `Balance`, `MetaData.*` | `PrivateNote`, `CustomerMemo`, `CustomField` |
| Customer | `Id`, `DisplayName` (`=`, `LIKE`), `CompanyName`, `GivenName`, `PrimaryEmailAddr`, `Active`, `MetaData.*` | - |
| Payment  | `CustomerRef`, `TotalAmt` (combined with `AND`)                       | - |

- Combined filters work: `CustomerRef = '88' AND TotalAmt = '42.50' AND TxnDate =
  '2026-10-01'` finds the invoice; `TotalAmt` matches `'42.5'` and `'42.50'` alike.
- `LIKE` on a non-queryable property is reported as a parse error (`4000`), not `4001`.
- Matching keys and their limits (facts from earlier sections): `DocNumber` is not unique
  (5.2) and comparisons ignore case; `DisplayName` is unique but changes on deactivation
  (5.1); amounts and dates are not unique.

### 13.2 Where an external id can live on an invoice

| Field          | Stored | Findable by query | Survives                        |
|----------------|--------|-------------------|---------------------------------|
| `DocNumber`    | yes, ≤ 21 chars, no uniqueness | yes (`=`, `LIKE`, case-insensitive) | sparse and full updates (cannot be cleared) |
| `PrivateNote`  | yes, ≤ 4000 chars | **no**         | sparse updates; **cleared by a full update**; rewritten by void (`"Voided - "` prefix) |
| `CustomField`  | see below | **no**          | sparse updates; **cleared by a full update** (`CustomField: []`) |

- **Custom fields:** this company has all three sales custom fields **disabled**
  (`Preferences.SalesFormsPrefs.CustomField`: `UseSalesCustom1..3 = false`). Even so,
  `CustomField: [{ DefinitionId: "1", Type: "StringType", StringValue }]` is accepted and
  returned on GET; `DefinitionId: "7"` is silently dropped. Whether a value on a disabled
  field is visible in the QBO UI is not verified.
- There is no dedicated external-id field on Invoice.

## 14. Webhooks

Configured per app in the developer portal (endpoint URL, entities); the portal shows a
verifier token used to sign deliveries.

### 14.1 Delivery format

`POST` to the endpoint, `content-type: application/json; charset=utf-8`, user agent
`intuit_notification_server/1.0`. Body (legacy format, schema version `1.0`):

```json
{ "eventNotifications": [{ "realmId": "9341458506606758",
    "dataChangeEvent": { "entities": [
      { "id": "245", "operation": "Update", "name": "Invoice",
        "lastUpdated": "2026-10-16T14:05:42.000Z" } ] } }] }
```

- **A notification, not the data:** entity name, id, operation, `lastUpdated` (UTC).
  No `SyncToken`, no fields - the record must be fetched (GET or CDC) to know its state.
- `lastUpdated` has whole seconds for creates / updates / voids (matching
  `MetaData.LastUpdatedTime`) but **milliseconds for deletes**
  (`2026-10-16T14:06:16.162Z`).
- Headers: `intuit-signature`, `intuit-t-id` (a UUID, unique per delivery),
  `intuit-created-time` (ISO, ms), `intuit-notification-schema-version: 1.0`.
- **One event per delivery** in every case seen (19 deliveries, writes 0.5-7 s apart). The
  format allows more (`eventNotifications` and `entities` are arrays), so a receiver must
  handle several.

### 14.2 Signature

`intuit-signature` = base64(HMAC-SHA256(raw request body, verifier token)). Verified on
every delivery (computed over the raw bytes, before JSON parsing).

### 14.3 What fires

| Write (API or UI)                                   | Event(s) delivered                       |
|-----------------------------------------------------|------------------------------------------|
| Customer create / sparse update                     | `Customer` `Create` / `Update`           |
| Invoice create / update                             | `Invoice` `Create` / `Update`            |
| Invoice update that changes nothing (no-op, 6.1)    | **none**                                 |
| Invoice void                                        | `Invoice` **`Void`**                     |
| Invoice delete                                      | `Invoice` `Delete`                       |
| Payment create applied to an invoice                | `Payment` `Create` only - **no `Invoice` event**, although the invoice's `Balance`, `LinkedTxn` and `SyncToken` changed |
| Payment void (`include=void`)                       | `Payment` `Void` - no `Invoice` event    |
| Payment delete                                      | `Payment` `Delete` - no `Invoice` event  |
| JournalEntry create; Account create                 | `JournalEntry` / `Account` `Create`      |
| Opening an invoice in the QBO UI                    | `Preferences` `Update` (id `1`)          |

- **The application's own API writes are delivered back** to it, exactly like changes
  made by others; nothing in the event distinguishes them.
- Invoice changes caused by payments are not notified (an invoice went from `SyncToken` 1
  to 5 through four payment operations with no Invoice event). Neither were the balance
  changes of Accounts (A/R, Undeposited Funds) or Customers - which CDC does report (10).
- **Latency:** 0.2-0.3 s from the write to the delivery.
- No duplicate deliveries were seen while the endpoint answered 200 within milliseconds.

### 14.4 Retries and failures

Receiver answering HTTP 500 to everything; one Customer update at `t = 0`. The same event
(same entity, id, operation, `lastUpdated`) was delivered at exactly the same offsets in
two separate runs (watched 17 min and 60 min):

| Attempt | `+t`    | Gap since previous |
|---------|---------|--------------------|
| 1       | 0.2 s   | -                  |
| 2       | 0.7 s   | 0.5 s              |
| 3       | 21 s    | 20 s               |
| 4       | 51 s    | 30 s               |
| 5       | 111 s   | 60 s               |
| 6       | 412 s   | 5 min              |
| 7       | 1613 s  | 20 min             |

- **7 attempts over ~27 minutes, then none** in the remaining 33 minutes of the watch: an
  event whose deliveries keep failing is dropped after about half an hour.
- **Each attempt has a new `intuit-t-id`** (and `intuit-created-time`), so the header
  identifies a delivery attempt, not the event; duplicates can only be recognised by the
  payload (entity + id + operation + `lastUpdated`).
- Changing the endpoint URL in the portal did not bring back an event whose retries were
  pending against the old URL.
- **After the failed hour, deliveries stopped:** two later writes (16:09 and 16:12 UTC,
  with a working endpoint) produced no delivery at all within 13 and 10 minutes. The
  portal showed no status or warning for the endpoint. Whether Intuit suspends an endpoint
  after repeated failures, or this was a sandbox delivery outage, is not confirmed. For
  the same reason the slow-response test (200 after 15 s) produced no data.
- The portal has an "Enable cloud event payload format" toggle per app (off by default):
  the legacy `eventNotifications` format of 14.1 is the default, CloudEvents is opt-in.

## 15. Edits made in the QBO web UI

The sandbox company opens at `https://sandbox.qbo.intuit.com/app/invoice?txnId=<Id>`
(from developer.intuit.com -> Sandbox). UI writes behave like API writes for webhooks
(14.3) and `SyncToken`, with these differences:

- **`LastModifiedByRef` is the same user id for UI and API writes** (the sandbox user) -
  it cannot tell who made a change.
- Editing a line in the UI keeps its `Id`, fills `UnitPrice` (and `Qty: 1` on new lines)
  and may add `Description`; saving adds `TxnTaxDetail.TxnTaxCodeRef` (company tax code
  `2`) and a `TaxLine`, even on an invoice created through the API without them. From
  then on, API updates of its lines must send `TxnTaxCodeRef` too (5.2).
- **UI-created invoices carry sales tax**: a new $15 "Services" invoice saved in the UI has
  `TotalTax` 1.20 and `TotalAmt` 16.20 (`NetAmountTaxable` 15), while its line shows
  `TaxCodeRef: NON` - a combination that yields tax 0 when sent through the API (5.2).
- `DocNumber` is assigned from the company sequence (`1082`); the UI has no number field
  while custom transaction numbers are off.
- "Receive payment" from an invoice prefills the full open balance; the result is an
  ordinary Payment (`DepositToAccountRef` Undeposited Funds) linked to the invoice.
- UI void (More actions -> Void, confirmation "You can't undo this") gives the same result
  as the API void (8.1): lines and tax zeroed (`Qty: 0` kept), `PrivateNote` `"Voided"`
  when it was empty, `SyncToken` +1, webhook `Void`.

## A. Gotchas

1. "Not found" is HTTP 400 `ValidationFault` code `610`, not 404.
2. 401 responses use a different, lowercase envelope with `time` in epoch ms.
3. `minorversion` is never validated; a typo silently gets version 75.
4. `QueryResponse.totalCount` is the page size (or absent), not the total.
5. An empty query result is `QueryResponse: {}`.
6. Field-list queries return `Line: []` whatever the real lines are.
7. Timestamps have one-second precision, and filter values are truncated to seconds.
8. Every invoice gets an extra `SubTotalLineDetail` line without an `Id`.
9. A sales line without `ItemRef` silently becomes item "Services".
10. Sales tax is not applied on API creates unless both line and transaction tax codes are
    sent.
11. `CurrencyRef` is silently ignored when multicurrency is off.
12. Amounts are silently rounded to cents.
13. Duplicate invoice `DocNumber`s are accepted silently.
14. Deactivating a customer or item renames it `"... (deleted)"`; inactive records vanish
    from queries, and the original name can be created again (no `6240`).
15. Applying a payment bumps the invoice's `SyncToken`.
16. A sparse update that includes `Line` deletes every line not sent.
17. A full update resets omitted fields, including `TxnDate` (-> today) and `DueDate`.
18. No-op updates return 200 without bumping `SyncToken`.
19. Line Ids are never reused; an unknown line Id silently creates a new line.
20. In sparse updates `null` is ignored and `""` clears (except `DocNumber`).
21. A `requestid` replay ignores the new body and returns the old response, with no replay
    marker; a replayed create returns the record as it was, even if since deleted.
22. Concurrent requests with one `requestid` get HTTP 425 with an empty body.
23. A failed request's `requestid` is not remembered: the same key can be retried with a
    fixed body.
24. A `requestid` reused on another entity type, or longer than 50 chars, gives `6000`
    worded as a transient error.
25. A client timeout says nothing about the server: the write may have happened.
26. A voided invoice has no void flag - only a `"Voided - "` prefix in `PrivateNote`.
27. A voided invoice can be voided again, edited and given a non-zero total again.
28. Invoice delete ignores the `SyncToken` value (it only has to be present).
29. Void / delete of an invoice unlinks its payments, which become unapplied - and
    unapplied payments are auto-applied to the customer's next invoice, so a create can
    return `SyncToken: "1"` and a reduced `Balance`.
30. A payment referencing a voided invoice is stored unapplied, without error.
31. Payment void is `?operation=update&include=void`, not `?operation=void`; it zeroes the
    amount.
32. Reducing a paid invoice below the amount paid is accepted; the excess becomes unapplied
    credit on the payment.
33. There is no paid / unpaid status field; only `Balance`.
34. Over-applied or mis-applied payments (above the balance, on a paid invoice, one line
    with two invoices) are accepted and silently stored as unapplied credit.
35. Changing an invoice's `CustomerRef` silently unapplies its payments.
36. An update can bump an invoice's `SyncToken` by 2 (the update plus an automatic
    payment application).
37. `/cdc` returns errors with HTTP 200 (`SystemFault` `10000`).
38. CDC returns each changed record once, in its current state - not a change log.
39. CDC's `changedSince` is exclusive, while query timestamp filters `>=` include the
    boundary.
40. Deleted records in CDC are stubs with `status: "Deleted"`; voided ones are unmarked.
41. Inactive customers appear in CDC but not in queries.
42. Sales lines have no account field; the posting account comes from the item.
43. Deactivating an Account renames it `"... (deleted)"`, like a Customer.
44. JournalEntry `?operation=void` returns 200 and does nothing.
45. JournalEntry `TotalAmt` is 0 in responses.
46. A JournalEntry line on A/R changes the customer's balance (it needs a customer).
47. A sandbox record with a future `LastUpdatedTime` shows up in every CDC window.
48. The per-second limit (~10/s per realm) is hit long before the per-minute one; a burst
    of more than ~12 parallel requests gets 429s at once.
49. 429 and 401 bodies use the lowercase `fault` envelope; other errors use `Fault`.
50. `/batch` returns 200 with per-item faults: partial success is normal.
51. `PrivateNote` and `CustomField` cannot be queried; only `DocNumber` can carry a
    searchable external key.
52. Query string comparisons are case-insensitive; quotes are escaped with `\'`.
53. A full update clears `CustomField` as well as `PrivateNote`.
54. Webhooks carry only entity, id, operation and time - always refetch.
55. An application's own API writes come back as webhooks.
56. Payment create / void / delete change the invoice but emit no Invoice webhook.
57. Webhooks report `Void` as an operation; CDC and GET don't mark voids.
58. Webhook `lastUpdated` has milliseconds for deletes only.
59. `LastModifiedByRef` doesn't distinguish UI edits from API writes.
60. Invoices created in the UI include sales tax that the API would not compute.
61. A failing webhook endpoint gets 7 attempts in ~27 min, then the event is dropped;
    deliveries then stopped altogether for 13+ min without any notice in the portal.
62. A `requestid` is scoped per entity type: reusing it for a write to another record
    returns the stored response of the first write and changes nothing.
63. Once an invoice has `TxnTaxCodeRef` (any UI save adds it), updating its lines without
    resending `TxnTaxCodeRef` fails with `6000` "error while calculating tax".

## B. Minimal request bodies

```jsonc
// POST /customer
{ "DisplayName": "Acme Ltd" }

// POST /invoice   (omit Qty/UnitPrice, or make them multiply to Amount exactly)
{ "CustomerRef": { "value": "60" }, "DocNumber": "INV-0001",
  "Line": [{ "Amount": 100, "Description": "...", "DetailType": "SalesItemLineDetail",
             "SalesItemLineDetail": { "ItemRef": { "value": "1" } } }] }

// POST /invoice   sparse header update: only the sent fields change
{ "Id": "157", "SyncToken": "3", "sparse": true, "PrivateNote": "..." }

// POST /invoice   line change: the full line list; existing lines keep their Id
{ "Id": "157", "SyncToken": "4", "sparse": true,
  "Line": [{ "Id": "1", "Amount": 100, "DetailType": "SalesItemLineDetail", "SalesItemLineDetail": { "ItemRef": { "value": "1" } } },
           { "Amount": 50, "DetailType": "SalesItemLineDetail", "SalesItemLineDetail": { "ItemRef": { "value": "1" } } }] }

// POST /payment
{ "CustomerRef": { "value": "60" }, "TotalAmt": 40,
  "Line": [{ "Amount": 40, "LinkedTxn": [{ "TxnId": "157", "TxnType": "Invoice" }] }] }
```

## C. Open questions

- Default page size without `maxresults` (docs: 100) - not observable in this sandbox.
- Shape of 5xx responses - none seen, none provoked.
- Whether a custom field value on a disabled definition shows in the QBO UI (13.2).
- Why webhook deliveries stopped after an hour of failures, and for how long; response
  timeout for slow endpoints (14.4).
- The per-minute limit (500) was not reached; only the per-second behaviour was observed.
- Whether `minorversion` changes field *values* - only field sets were compared.
- CDC look-back limit and the 1,000-objects cap - not reachable in this sandbox.
- How long a `requestid` is remembered beyond the time measured (see 7); whether a request
  that failed with 5xx is remembered; whether keys are scoped per realm or per app.

## D. Evidence index

Scripts are in `qbo-playground/src/explore/`, run with
`pnpm qbo:explore <name>`. All runs 2026-10-16. `intuit_tid` is Intuit's
request trace id.

| Section | Script | Key `intuit_tid`s |
|---------|--------|-------------------|
| 2.1 minorversion | `01-basics` | `abc` accepted `1-6ad22351-4747ace7080dc7cb67d8cabf` |
| 2.1 field sets | `01b-query-edges` | (comparison output only) |
| 3 not found / 401 | `01-basics` | 610 `1-6ad22355-6a656e6d14d200945220b15d`; 401 `1-6ad22357-24961fcf3379a16d52e03724` |
| 3 required fields | `01-basics` | `1-6ad22356-69b31639343076e0778aa681` |
| 4 limits | `01-basics`, `01b-query-edges` | maxresults 1001 `1-6ad2235b-2d70ae1452d2058d631e1e6c`; 0 `1-6ad224a8-00526b18794a07921ba04292`; between `1-6ad224a7-46e43df545708162213d5cc6` |
| 4 paging | `01-basics`, `01b-query-edges` | `1-6ad22374-77fd6d935ceeae116189c643`; startposition 0 `1-6ad224a8-2ada9ceb5e84aa3d3ff933cb` |
| 4 case-insensitive | `01b-query-edges` | `1-6ad224ac-4b4ece59040a0f6531156c19` |
| 4 unknown property | ad-hoc `pnpm call query` | `1-6ad2236e-37970dc22704df715091f51f` |
| 4 timestamp boundary | `01b-query-edges` | (table output) |
| 5.1 duplicate name | `02-entity-shapes` | `1-6ad22533-656fa0c441cf6196469ac5cf` |
| 5.1 deactivate | `02-entity-shapes` | with balance `1-6ad2254c-34d8f20d6ad2c03060449fb3`; rename `1-6ad2254d-11a77ce231e7c66f296fe80c`; `6250` `1-6ad2254f-681fde322972c36220f923f1` |
| 5.2 minimal invoice | `02-entity-shapes` | `1-6ad22536-2550e7690886e50d26206b2c` |
| 5.2 line rules | `02-entity-shapes` | empty detail `1-6ad22535-1c9b3d6115005ce62bff264d`; ItemRef default `1-6ad22535-062c23d83fbbfce753233c0a`; `6070` `1-6ad22539-08dbbeb216323362057cd5cf`; rounding `1-6ad2253a-47e9bcab0e3389ed1b1c09cb` |
| 5.2 tax | `02-entity-shapes` | not defaulted `1-6ad22540-3373e71062b1d5282b672dc7`; computed `1-6ad22543-742b33f205985868601923a8` |
| 5.2 currency | `02-entity-shapes` | `1-6ad22547-088814d125eb66b4578eb9d0` |
| 5.3 payment | `02-entity-shapes` | create `1-6ad2254a-52e9fd7d01fe5dca2bb36c99`; invoice after `1-6ad2254b-79c89583760121617af1ae9b` |
| 6.1 SyncToken | `03-updates`, `03b-synctoken` | stale `1-6ad225e9-0c7baa584fa4b4093f0e41d3`; race `1-6ad225cb-01d165526f4040f263061938` / `1-6ad225cc-382d195e6c6993230f82342a`; no-ops `1-6ad225b6-3644417b560fae633ea86981`, `1-6ad225b9-05e561611d19004b406b520c` |
| 6.2 sparse / full | `03-updates`, `03b-synctoken` | sparse Line `1-6ad225be-16361aff74a2d3366fb58e01`; full clears `1-6ad225bf-42da9b0669d91a9134044254`; TxnDate reset `1-6ad225eb-3379d5ed647f8e0f4c3cb3c4` |
| 6.3 lines | `03-updates` | unknown Id `1-6ad225c2-38b7771b42770d34743bf019` |
| 5.2 duplicate DocNumber | `03-updates` | `1-6ad225c7-247e930d2132f95d09443d92` |
| 6.4 atomicity | `03-updates` | `1-6ad225cd-080e7b4031a75d787943ffc1` |
| 7 replay | `04-idempotency` | create `1-6ad227d1-4ada4ab90d6d47ff2d42c621` / replay `1-6ad227d3-6e75f463307f218329a58797`; different body `1-6ad227d3-76f420814452811031ba0cfd`; other entity `1-6ad227d3-1eed043d5ba168a62b1fe521` |
| 7 update / delete / payment | `04-idempotency` | update replay `1-6ad227d5-115a578b2023f5197144d90d` vs no key `1-6ad227d5-2dc097807c6c1b300d58496c`; delete replay `1-6ad227da-18e7d148410a49f60aadd413`; payment replay `1-6ad227d8-1295a1b5674b0215794ce640` |
| 7 timeout, no key | `04-idempotency` | retry `1-6ad227df-1524ce8510073f7e7e2ecdd9` (counts in output) |
| 7 concurrency, 425 | `04b-idempotency-edges` | `1-6ad227fe-7120fc7a5713530963d8d276` |
| 7 failed key, length, snapshot | `04b-idempotency-edges` | failed then ok `1-6ad227ff-4d04307a35c35bf058c01b13`; 51 chars `1-6ad22804-541ef79a31a8f387524b41a6`; after delete `1-6ad22807-5fb76306246910187fca5335` |
| 9.1 applying | `06-payments` | partials `1-6ad22940-481fad4d70e4f6970ac337a0`, `1-6ad22942-2996be606104b50821d1d539`; clipped `1-6ad22946-34aa8af6582992bb5e172d48`; split `1-6ad2294e-5b6a51b015c0c11c2fd8323a`; two LinkedTxn `1-6ad2294f-03ce5a1c630d337739327f81`; `620` `1-6ad22955-4f9da4b14a6f3ba8326c5af6`; lines > total `1-6ad22949-69b034060eab73922b93f426` |
| 9.2 automatic changes | `05b-void-delete-isolated`, `06-payments`, ad-hoc `pnpm call` | on create (output); on raise `1-6ad22969-72d66b906bbce5b626b01ac1`; customer change `1-6ad22959-6c7d52be106d15c431991843`; payment edit `1-6ad22952-534c53ed6f5232d74b973f34` |
| 8.1 invoice void | `05-void-delete`, `05b-void-delete-isolated` | void `1-6ad2288a-66fc87415b34233821f65d9c`; no token `1-6ad22889-25dae5071babfdd7263801d1`; void again `1-6ad2288c-133947634b0b428334c03849`; revived `1-6ad2288e-38bdb5a92fd8a670289614f8`; partially paid `1-6ad22898-691415e007fb34ab17eb739f` |
| 8.2 invoice delete | `05-void-delete`, `05b-void-delete-isolated` | stale token `1-6ad228da-4d32d40245c9aeca0a14ba86`; no token `1-6ad228dc-0665de6728f925f2319272a3`; update after `1-6ad22894-4947ed246c7441251fb1ddab` |
| 8.3 payment void / delete | `05-void-delete`, `05b-void-delete-isolated`, ad-hoc `pnpm call` | `include=void` `1-6ad228e2-188cd4d67ce0061963960716`; `operation=void` `1-6ad228a2-4a8cc7ac735da9603b100834`; revive `1-6ad228f3-0d498c79319238ae649a0501`; delete `1-6ad228a6-337143ab030db7164fd31c86` |
| 8.4 edit below paid | `05b-void-delete-isolated` | `1-6ad228df-4bb445ed546e80536b421d2d` |
| 9.1 payment vs voided invoice | `05b-void-delete-isolated` | `1-6ad228d7-07fbd255402892a37a40a633` |
| 10 shape, deleted, voided, order | `07-cdc` | `1-6ad229ab-68a63113239f69e64e85c198` |
| 10 parameters | `07-cdc`, `07b-cdc-edges` | unknown entity `1-6ad229b1-63dab5113fc9c27f7a60efb3`; no changedSince `1-6ad229d3-21a0324f2b3eed8547a7cbd9`; 365 days `1-6ad229d0-6a588b7a1d603dca4a440267`; boundary (output) |
| 10 latency | `07-cdc` | (timing output) |
| 11.1 accounts | `09-gl` | create `1-6ad22a33-4c6ccbf520f67fe8547df89f`; duplicate `1-6ad22a34-3bc602e93adde697125741f1`; colon `1-6ad22a34-5fa434591119d2ea6217ac68`; delete `1-6ad22a36-5095a0260eef707f4b34d330`; deactivate `1-6ad22a36-7c1584cf62046068679d3dd9` |
| 11.2-11.3 postings, reports | `09-gl` | GL `1-6ad22a3b-46e27e0d421339024de3cb05`; TB `1-6ad22a3c-5bd7229f1aec317e0bf2f1e0` |
| 11.4 JournalEntry | `09-gl`, ad-hoc `pnpm call` | unbalanced `1-6ad22a3c-1f067db178d3522a72e87a67`; A/R no customer `1-6ad22a3d-3c6ed157291f49b20e5764d1`; create `1-6ad22a3d-7b77f2c2519521d31d6af402`; void no-op `1-6ad22a5d-158d7b8d51dfab1b62cc799a` / re-read `1-6ad22a5e-79eb97bc7849683718fcdd2a`; delete `1-6ad22a40-6d1bc6a559d5d4bd64948731` |
| 11.5 CDC | `09-gl` | `1-6ad22a40-5b5b48a53a8ccfa96ac642b9` |
| 12.1 throttling | `10-limits`, `10b-throttle` | 429 `1-6ad22b2c-67568f976a41ddc90af19dd3`; concurrency steps (output) |
| 12.2 tokens | `10-limits` | (token endpoint, output only - no tid) |
| 12.3 batch | `10-limits` | partial `1-6ad22b30-60cf2ca2511d486b0cb69ad6`; 31 items `1-6ad22b30-4b1eec3f6609e60f16bcb7f2` |
| 13.1 queryable fields | `12-matching` | PrivateNote `1-6ad22d0c-0d938d7e039b12532f159fdd`; CustomField `1-6ad22d0d-7f69bd751633814d1b8d0034`; combined `1-6ad22d0c-395c80b4578cf58a00d4aeed`; escape `1-6ad22d11-38a2ae3e03cee78c35a1a5c9` |
| 13.2 custom field | `12-matching`, ad-hoc `pnpm call` | create `1-6ad22d07-71fc7763725ca8fd38ee0097`; sparse keeps `1-6ad22d1d-2fea188366478142613ef960`; full clears `1-6ad22d1f-38b550651eb14e7927f67260`; id 7 dropped `1-6ad22d21-71ddcd4f1646148c500ae5d3` |
| 14 webhooks | `08-webhooks`, receiver `pnpm webhooks` | deliveries in `qbo-playground/webhooks.log` (gitignored); `intuit-t-id` e.g. `cae82b7e-5bab-44ca-a793-2ade050cc0a4` (Customer Create), `f4d397c6-16a9-4ff5-8800-376e0f8fe085` (Customer Update) |
| 14.4 retries | `08b-webhook-retries 90 30` / `90 60` with `pnpm webhooks 4001 500` | run 1 `3a980aae-7fda-425f-8cee-2fb8f261d16b` ... `d5089e10-2c2c-468f-b25a-edb157d4e16c` (6 attempts, 17 min); run 2 `08208e1a-70fe-43f7-a069-2a71e8920b3a` ... `fa036f8f-6c34-4269-9a03-e69c4fd7ad2d` (7 attempts, 60 min) |
| 14.4 deliveries stopped | `08b-webhook-retries 90 10` with `pnpm webhooks 4001 200 15000`, ad-hoc customer create | writes `1-6ad24cf6-4a803be016078dc0594eb538` (16:12) and the 16:09 customer 90 update: no delivery |
| 15 UI edits | manual UI session via browser + `pnpm call` diffs | invoices 245 (edit, payment 251), 252 (UI create + void) |
| 6.1 read-after-write, 6.3 lines without Ids on a paid invoice, 8.2 stale delete | `13-verify` | stale delete `1-6ad2529b-0ea2e19703850b8218a87bcd`; others (output) |
| 7 key scope | `13-verify` | A `1-6ad252bc-28573e9f4ecaea3172945060`, B `1-6ad252bd-745921531b4c34943109fce2`; create key on update `1-6ad252bf-6bbb26125eb29c8112bb34ab` |
| 5.2 / 15 updates of taxed invoices | `13-verify`, ad-hoc on UI-edited invoice 245 | API-taxed `1-6ad25354-334d04c95c647fb5497de4f4`; UI-edited `1-6ad252ef-47a1b9d93ba2ce347fead3a1`; with code `1-6ad2530e-1bc2aca4255d52a14c8d67df` |
| 7 retention | `04b-idempotency-edges <key> <name>` | 2 min `1-6ad22836-34a520255c1ecde4100a34f1`; 27 min `1-6ad22e3d-74096f15044ed7615a0cb6c6` |

Test records created carry the `EXPLORE-` prefix (customers 60+, invoices 156+,
payments 174+).
