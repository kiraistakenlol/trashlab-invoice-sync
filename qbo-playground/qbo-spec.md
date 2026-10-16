# QuickBooks Online Accounting API - observed behaviour

<!-- last-updated: 2026-10-16 -->

How the QuickBooks Online (QBO) Accounting API v3 actually behaves, established by running
experiments against a sandbox company. It complements Intuit's reference documentation:
it records what the docs leave out, get wrong, or state only vaguely.

**Status tags.** Statements are **verified** (observed in the sandbox; evidence in
Appendix D) unless marked **docs** (taken from documentation, not observed; source linked).

**Coverage so far:** request conventions, errors, query language, Customer / Invoice /
Payment shapes, create and update semantics, `requestid` idempotency, void and delete,
payments and balances, change data capture. Not yet covered: webhooks, Account / Item /
JournalEntry, rate limits and token lifecycle, edits made in the QBO web UI.

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
| `500`  | Unsupported Operation                    | unknown entity in path; `?operation=delete` on Customer |
| `425`  | (empty body, `text/xml`; HTTP **425**)   | a request whose `requestid` is still being processed (see 7) |
| `610`  | Object Not Found                         | payment linking an unknown invoice id; GET by an id that doesn't exist or was deleted; deleting an already deleted invoice; updating or voiding a deleted invoice ("Another user has deleted this transaction") |
| `620`  | TxnID Cannot Be Linked                   | payment linking another customer's invoice         |
| `2010` | Request has invalid or unsupported property | malformed JSON body; unknown entity in `/cdc` `entities` |
| `2020` | Required param missing                   | no `Line`, empty `Line: []`, empty/missing `SalesItemLineDetail`; delete without `SyncToken`; sparse Payment update without `CustomerRef` |
| `2050` | String length ... Min:0 Max:N            | `DocNumber` > 21, `PrivateNote` > 4000             |
| `2500` | Invalid Reference Id                     | unknown `CustomerRef` / `ItemRef`                  |
| `2240` | Number out of range (Min:0 ...)          | negative Payment `TotalAmt`                        |
| `3200` | AuthenticationFailed (HTTP **401**)      | bad access token                                   |
| `4000` | Error parsing query                      | syntax error, `OR`, `BETWEEN`, negative number     |
| `4001` | Invalid query                            | unknown entity/property, `maxresults` 0 or > 1000  |
| `5010` | Stale Object Error                       | update with a stale, future or missing `SyncToken` |
| `6000` | Business Validation Error                | invoice total < 0; `requestid` > 50 chars; `requestid` reused on another entity (see 7); invoice void without `SyncToken` ("never been saved"); Payment `?operation=void` (see 8.3); payment lines exceeding `TotalAmt`, or `TotalAmt` missing / 0 (see 9) |
| `6070` | Amount calculation incorrect             | `Amount` ≠ `Qty × UnitPrice`                       |
| `6220` | Delete List Has Balance Error            | deactivating a customer with an open balance       |
| `6240` | Duplicate Name Exists Error              | Customer `DisplayName` already used                |
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
- **A key is tied to the entity it was first used on.** Reusing an invoice-create key for
  a customer create gives `6000` "An unexpected error occurred ... Please wait a few
  minutes and try again" - misleading, retrying does not help.
- **Length: at most 50 characters** (51 -> `6000` "You cannot enter more than 50
  characters in the request_id field"). A UUID (36) fits.
- **Client timeout, then retry:** a create aborted by the client (timeouts of 1, 50, 150
  and 300 ms, all with one key) still created the invoice server-side once; a retry with
  the same key returned that invoice. One record in total.
- **Without a key, a retried create duplicates** (two identical keyless creates -> two
  invoices with the same `DocNumber`).
- **Retention:** a key was still honoured about 2 minutes after first use. Longer retention not
  measured.

| Request                                                       | Result |
|---------------------------------------------------------------|--------|
| create, key A; again, key A, same body                        | 200, same `Id`, same body |
| create, key A, different body                                 | 200, first response; body ignored |
| create on another entity, key A                               | 400 `6000` |
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
- **No void flag.** The response, GET and query carry no status field; compared field by
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
  (`UnappliedAmt: 10`). No error or warning.

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
- Whether webhooks report a void as such (CDC does not, see 10).
- CDC look-back limit and the 1,000-objects cap - not reachable in this sandbox.
- How long a `requestid` is remembered beyond the time measured (see 7); whether a request
  that failed with 5xx is remembered; whether keys are scoped per realm or per app.

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
| 7 retention | `04b-idempotency-edges <key> <name>` | 2 min `1-6ad22836-34a520255c1ecde4100a34f1` |

Test records created carry the `EXPLORE-` prefix (customers 60+, invoices 156+,
payments 174+).
