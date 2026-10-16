# QuickBooks Online Accounting API - observed behaviour

<!-- last-updated: 2026-10-16 -->

How the QuickBooks Online (QBO) Accounting API v3 actually behaves, established by running
experiments against a sandbox company. It complements Intuit's reference documentation:
it records what the docs leave out, get wrong, or state only vaguely.

**Status tags.** Statements are **verified** (observed in the sandbox; evidence in
Appendix D) unless marked **docs** (taken from documentation, not observed; source linked).

**Coverage so far:** request conventions, errors, query language, Customer / Invoice /
Payment shapes, create and update semantics. Not yet covered: `requestid` idempotency,
void and delete, payment and balance rules, change data capture, webhooks, Account / Item /
JournalEntry, rate limits and token lifecycle, edits made in the QBO web UI.

## Contents

1. Test environment
2. Request conventions
3. Errors
4. Query language
5. Entities: Customer, Invoice, Payment
6. Writes: create and update
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
| `500`  | Unsupported Operation                    | unknown entity in path; `?operation=delete` on Customer |
| `610`  | Object Not Found                         | GET by an id that doesn't exist                    |
| `2010` | Request has invalid or unsupported property | malformed JSON body                             |
| `2020` | Required param missing                   | no `Line`, empty `Line: []`, empty/missing `SalesItemLineDetail` |
| `2050` | String length ... Min:0 Max:N            | `DocNumber` > 21, `PrivateNote` > 4000             |
| `2500` | Invalid Reference Id                     | unknown `CustomerRef` / `ItemRef`                  |
| `3200` | AuthenticationFailed (HTTP **401**)      | bad access token                                   |
| `4000` | Error parsing query                      | syntax error, `OR`, `BETWEEN`, negative number     |
| `4001` | Invalid query                            | unknown entity/property, `maxresults` 0 or > 1000  |
| `5010` | Stale Object Error                       | update with a stale, future or missing `SyncToken` |
| `6000` | Business Validation Error                | invoice total < 0                                  |
| `6070` | Amount calculation incorrect             | `Amount` ≠ `Qty × UnitPrice`                       |
| `6220` | Delete List Has Balance Error            | deactivating a customer with an open balance       |
| `6240` | Duplicate Name Exists Error              | Customer `DisplayName` already used                |
| `6250` | Invalid Customer                         | transaction for an inactive customer               |
| `6520` | Missing Inventory Item Quantity          | inventory item line without `Qty`                  |
| `6560` | CustomerRef is required                  | invoice without `CustomerRef`                      |

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
filters on `Active = false`; GET by id still returns them.

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
  customer. Both round-trip unchanged.
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
| `DueDate` < `TxnDate`                            | 200, stored as sent |
| `CurrencyRef EUR`                                | 200, stored as USD |
| unknown `ItemRef`                                | 400 `2500` |
| `PrivateNote` 4000 / 4001 chars                  | 200 / 400 `2050` |

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
14. Deactivating a customer renames it `"... (deleted)"`; inactive records vanish from
    queries.
15. Applying a payment bumps the invoice's `SyncToken`.
16. A sparse update that includes `Line` deletes every line not sent.
17. A full update resets omitted fields, including `TxnDate` (-> today) and `DueDate`.
18. No-op updates return 200 without bumping `SyncToken`.
19. Line Ids are never reused; an unknown line Id silently creates a new line.
20. In sparse updates `null` is ignored and `""` clears (except `DocNumber`).

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
- Shape of 5xx responses - none seen yet.
- Whether `minorversion` changes field *values* - only field sets were compared.

## D. Evidence index

Scripts are in `qbo-playground/src/explore/`, run with
`pnpm -C qbo-playground explore <name>`. All runs 2026-10-16. `intuit_tid` is Intuit's
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

Test records created carry the `EXPLORE-` prefix (customers 60-63+, invoices 156+,
payments 174-175).
