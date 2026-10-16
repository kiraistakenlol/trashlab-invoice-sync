# QBO Accounting API - verified behaviour

<!-- last-updated: 2026-10-16 -->

How the QuickBooks Online Accounting API behaves in our sandbox (realm `9341458506606758`,
US company). Every finding is tagged **verified** (seen in the sandbox; script +
`intuit_tid`) or **docs** (Intuit or third-party documentation, not verified; link given).
Progress and open areas: `EXPLORATION.md`.

Run any experiment with `pnpm -C qbo-playground explore NN-<topic>`.

## 1. Basics: versions, errors, query

### Summary

- **minorversion:** every value is accepted with HTTP 200 - none, 1-80, `999`, even `abc`
  - and the field sets of Invoice, Customer, Payment, Item, Account and CompanyInfo are
  identical across none / 1 / 75 / 999 (field *sets* only; values were not diffed). Intuit made 75 the floor on 2025-08-01: anything
  below 75 (or missing) is served as 75. We keep sending `75` explicitly.
- **Envelope:** reads `{ <Entity>: {...}, time }`; queries `{ QueryResponse: { <Entity>: [...],
  startPosition, maxResults, totalCount }, time }`; errors `{ Fault: { Error: [...], type },
  time }`.
- **Errors are mostly HTTP 400 `ValidationFault`, including "not found"** (code `610`), not
  404. Classify by `Fault.Error[].code`, not by HTTP status.
- **401 (bad/expired token) has a completely different, lowercase envelope** (`fault.error[]`,
  `type: "AUTHENTICATION"`, code `3200`) plus `www-authenticate: Bearer ... error="invalid_token"`.
- **Query language:** SQL-like, single entity, case-insensitive keywords / entity /
  property names. `AND` only (`OR`, `BETWEEN` are parse errors); `=`, `!=`, `<`, `<=`, `>`,
  `>=`, `IN`, `LIKE 'x%'`; `orderby`; `startposition` (1-based, `0` treated as 1);
  `maxresults` 1..1000; `count(*)`.
- **Timestamp filters compare at whole seconds:** milliseconds in the filter value are
  dropped (`>= 13:16:17.500` matches a record at `13:16:17`). Offsets and `Z` are both
  honoured; a bare date works too.
- **Default order (no `orderby`) is stable and appears to be `LastUpdatedTime desc`** - but
  always pass `orderby` when paging.
- **`totalCount` is the number of rows in this page, not the grand total**, and is sometimes
  missing altogether (e.g. `where Id in (...)` on Account, `where Active = false`). Only
  `select count(*)` gives a total.
- An empty result is `QueryResponse: {}` - no entity key, no counts.
- **Field lists return `sparse: true` objects with `Line: []` and `LinkedTxn: []`** (plus a
  few always-included fields). An empty `Line` there does not mean "no lines": always read
  full records (`select *` or GET by id) before acting on them.
- **Timestamps:** `MetaData.CreateTime` / `LastUpdatedTime` are ISO-8601 with the company's
  offset (`-07:00`) and **whole-second precision**. `TxnDate` / `DueDate` are plain dates.
  The envelope `time` has milliseconds.

### Details

**minorversion.** `GET /companyinfo/{realm}` returned 200 with identical keys for `null`,
`1`, `40`, `65`, `70`, `73`, `74`, `75`, `76`, `80`, `999`, `abc`. `GET /invoice/{id}` with
`null`, `1` and `75` returned the same 32 top-level fields. No warning in body or headers for
invalid values.

**Error catalogue** (all `Fault.type = "ValidationFault"`, HTTP 400 unless noted):

| Situation                               | code   | Message                                    |
|-----------------------------------------|--------|--------------------------------------------|
| GET by unknown id                       | `610`  | Object Not Found                           |
| Unknown entity in path (`/nosuchentity`)| `500`  | Unsupported Operation                      |
| Query parse error (`selec`, `OR`)       | `4000` | Error parsing query                        |
| Query: unknown entity / property, maxresults > 1000 | `4001` | Invalid query                 |
| Create without required fields          | `2020` (+ `6560` for CustomerRef) | Required param missing; several errors in one `Error[]` |
| Reference to unknown id (CustomerRef)   | `2500` | Invalid Reference Id                       |
| Malformed JSON body                     | `2010` | Request has invalid or unsupported property|
| Invalid access token (HTTP **401**)     | `3200` | `message=AuthenticationFailed; errorCode=003200; statusCode=401` |

Each error has `Message`, `Detail`, `code` (string) and usually `element`. The 401 body:

```json
{ "fault": { "error": [{ "message": "message=AuthenticationFailed; errorCode=003200; statusCode=401",
  "detail": "Malformed bearer token: too short or too long", "code": "3200" }], "type": "AUTHENTICATION" },
  "time": 1792156503951, "queryResponse": null, "cdcresponse": [], ... }
```

Note the type mismatch: there `time` is epoch millis, elsewhere an ISO string.

**Query.** Verified working:
- `select Id, DocNumber, TotalAmt, MetaData.LastUpdatedTime from Invoice` (field lists;
  `CompanyInfo` accepts `select *` only)
- `where MetaData.LastUpdatedTime > '2020-01-01T00:00:00-07:00'` and with `Z`
- `where Id in ('130', '999999')` (unknown ids silently skipped)
- `where DocNumber = '1001'`, `where DocNumber like '10%'`
- `where TotalAmt > '100'`, `where Balance > '0'` (numbers as quoted strings)
- `orderby MetaData.LastUpdatedTime desc`, `orderby Id`
- `startposition 30 maxresults 10` on 31 rows -> 2 rows, `totalCount: 2`
- `select count(*) from Invoice` -> `{ QueryResponse: { totalCount: 31 } }`
- `!=`, `<`, `<=` on `MetaData.LastUpdatedTime`
- `startposition 0` -> served as 1; `startposition 1000` past the end -> `QueryResponse: {}`
- `SELECT * FROM invoice WHERE docnumber = '1001' ORDERBY Id` - all case variants work

Rejected: `maxresults 0` (`4001` "Min allowed value is 1"), `maxresults 1001` (`4001`),
`startposition -1` (`4000`, lexer error), `between` (`4000`), `or` (`4000`).

**Timestamp boundary test** (`01b`), boundary record `LastUpdatedTime 2026-09-19T13:16:17-07:00`:

| Filter                          | Matches the record |
|---------------------------------|--------------------|
| `= t`, `>= t`, `<= t`           | yes                |
| `> t`, `< t`                    | no                 |
| `>= t` / `> t` written in UTC `Z` | yes / no (same instant) |
| `> t - 1s`, `> t - 500ms`       | yes                |
| `>= t + 500ms`                  | **yes** - ms dropped |
| `>= '2026-09-19'` (date only)   | yes                |

`where NoSuchField = 1` gives a misleading parse error ("expecting true/false"); with a
quoted value it gives the clear `4001 Property NoSuchField not found`.

Sandbox sizes at the time: 31 invoices, 29 customers, 18 items, 89 accounts.

### Evidence

- `src/explore/01b-query-edges.ts`, run 2026-10-16. **verified**. `intuit_tid`s: between
  `1-6ad224a7-46e43df545708162213d5cc6`; maxresults 0
  `1-6ad224a8-00526b18794a07921ba04292`; startposition 0
  `1-6ad224a8-2ada9ceb5e84aa3d3ff933cb`; lowercase keywords
  `1-6ad224ac-4b4ece59040a0f6531156c19`.
- `src/explore/01-basics.ts`, run 2026-10-16. **verified**. `intuit_tid`s:
  minorversion=abc `1-6ad22351-4747ace7080dc7cb67d8cabf`; not found
  `1-6ad22355-6a656e6d14d200945220b15d`; 401 `1-6ad22357-24961fcf3379a16d52e03724`;
  maxresults 1001 `1-6ad2235b-2d70ae1452d2058d631e1e6c`; paging
  `1-6ad22374-77fd6d935ceeae116189c643`; unknown property
  `1-6ad2236e-37970dc22704df715091f51f`.
- minorversion floor of 75 from 2025-08-01: **docs** -
  [Intuit blog](https://blogs.intuit.com/?p=34635),
  [Codat notice](https://docs.codat.io/updates/250219-qbo-minor-versions-update). Consistent
  with what we saw, but "same shape" is all we can observe.
- Default page size without `maxresults` is 100: **docs** only - no entity in the sandbox has
  more than 89 rows.

### Implications for the sync

- Error handling keys off `Fault.Error[].code`; HTTP status alone can't tell "not found"
  from "bad request". 401 -> refresh token and retry once; its body must be parsed
  separately (lowercase keys).
- A record that disappears from GET (`610`) may be deleted - confirm via CDC (area 7) rather
  than treat 610 as proof.
- Polling / reconciliation: `where MetaData.LastUpdatedTime > :cursor orderby
  MetaData.LastUpdatedTime` with `startposition` paging, stopping on an empty page (no grand
  total available). Timestamps and filters work at one-second precision, so use `>=` on the
  last seen second (verified to include it) and rely on idempotent processing for the
  repeats. Paging by offset while records change can skip or repeat rows - another reason
  for overlap + idempotency (or CDC, area 7).
- Never act on field-list query results; fetch full records.

## 2. Entity shapes

### Summary

- **Company setup (sandbox):** US, USD only (multicurrency off), sales tax on (tax code `2`
  "California" = 8 %), custom transaction numbers off, `AutoApplyPayments` on. Income
  account for item `1` "Services" is account `1`; payments default to account `4`
  "Undeposited Funds".
- **Customer:** minimal body `{ DisplayName }` (or `GivenName` alone - it becomes the
  DisplayName). `DisplayName` is unique **case-insensitively** (`6240`). No delete (`500
  Unsupported Operation`); deactivate with sparse `Active: false` - which **renames it to
  `"<name> (deleted)"`** and frees the original name for reuse. Deactivation is refused while
  the customer has an open balance (`6220`). Inactive customers are hidden from queries
  unless `where Active = false`, still readable by id, and cannot get new or edited
  transactions (`6250`).
- **Invoice:** minimal body = `CustomerRef` + one `SalesItemLineDetail` line with `Amount`
  and a non-empty `SalesItemLineDetail`. Omitting `ItemRef` (e.g. `{ Qty: 1 }`) silently uses
  item `1` "Services"; an empty `{}` is rejected as missing (`2020`).
- **DocNumber** is auto-assigned from a sequence (`1038`, `1039`, ...) when omitted, and any
  value ≤ 21 chars is accepted when supplied, even with custom transaction numbers off.
- **QBO adds a `SubTotalLineDetail` line** (no `Id`) to every invoice; it must be ignored
  when mapping lines and never sent back.
- **Line rules:** `Amount` must equal `Qty * UnitPrice` when both are sent (`6070`);
  amounts are rounded to cents (`10.005` -> `10.01`); negative lines allowed but total must
  be ≥ 0 (`6000`); zero-total and description-only invoices allowed; inventory items need
  `Qty` (`6520`).
- **Tax is never defaulted on API creates.** The customer's default tax code and the item's
  `Taxable` flag are ignored: lines get `TaxCodeRef: NON` and `TotalTax: 0` unless the body
  sends both line `TaxCodeRef: TAX` and `TxnTaxDetail.TxnTaxCodeRef`. Then QBO computes the
  tax (8 % -> `TotalAmt` 108 on 100) - even for an item marked non-taxable.
- **Silently ignored input:** `CurrencyRef: EUR` (stored as USD), `DueDate` before `TxnDate`.
- `PrivateNote` (internal, max 4000 chars) and `CustomerMemo` (customer-facing) round-trip.
- **Payment:** minimal body `{ CustomerRef, TotalAmt, Line: [{ Amount, LinkedTxn: [{ TxnId,
  TxnType: "Invoice" }] }] }`. Without lines it is accepted as fully unapplied
  (`UnappliedAmt = TotalAmt`). Response lines carry a noisy `LineEx` blob
  (`txnOpenBalance`, `txnReferenceNumber`) - ignore it.
- **Applying a payment modifies the invoice:** `Balance` drops, `LinkedTxn` gains the
  payment, and the invoice's **`SyncToken` increments** (0 -> 1).

### Details

**Full minimal invoice** as returned (`POST /invoice`, `intuit_tid`
`1-6ad22536-2550e7690886e50d26206b2c`), trimmed of the `AllowOnline*` flags:

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

`DueDate` defaults from the company's terms (Net 30). API-created invoices get
`AllowOnlinePayment / CreditCard / ACH: true`; pre-existing ones had them `false`.

A pre-existing invoice (`130`) shows the richer shape: `LinkedTxn` to an Estimate, lines with
`Description`, `Qty`/`UnitPrice`, `TaxCodeRef: TAX`, `TxnTaxDetail.TaxLine[]`,
`SalesTermRef`, `BillAddr`/`ShipAddr`, `BillEmail`.

**Invoice probes** (`02-entity-shapes.ts`):

| Body variation                                   | Result |
|--------------------------------------------------|--------|
| `SalesItemLineDetail: {}` or missing             | 400 `2020` Line.SalesItemLineDetail missing |
| `SalesItemLineDetail: { Qty: 1 }`                | 200, `ItemRef` = 1 "Services" |
| `DocNumber` 21 chars / 22 chars                  | 200 / 400 `2050` (max 21) |
| `Qty 2 × UnitPrice 50`, `Amount 99`              | 400 `6070` |
| `Amount 10.005`                                  | 200, stored `10.01` |
| lines `100` and `-30`                            | 200, total 70 |
| only line `-30`                                  | 400 `6000` "amount that is 0 or greater" |
| `Amount 0`; only a `DescriptionOnly` line        | 200, total 0 |
| inventory item (Pump) without `Qty`              | 400 `6520` |
| taxable item, no tax fields                      | 200, `NON`, tax 0 |
| taxable item, line `TAX` only                    | 200, `TAX`, tax 0 (no `TxnTaxCodeRef`) |
| taxable item, line `TAX` + `TxnTaxCodeRef 2`     | 200, tax 8, total 108 |
| non-taxable item, line `TAX` + `TxnTaxCodeRef 2` | 200, tax 8 (item flag ignored) |
| taxable item, line `NON` + `TxnTaxCodeRef 2`     | 200, tax 0, `TxnTaxCodeRef` dropped |
| `DueDate` < `TxnDate`                            | 200, stored as sent |
| `CurrencyRef EUR`                                | 200, stored as USD |
| unknown `ItemRef`                                | 400 `2500` |
| `PrivateNote` 4000 / 4001 chars                  | 200 / 400 `2050` (max 4000) |

**Customer probes:** duplicate `DisplayName` (same or other case) -> 400 `6240`;
`?operation=delete` -> 400 `500`; sparse `Active: false` with balance -> 400 `6220`, without
-> 200 and `DisplayName` becomes `"... (deleted)"`; invoice for an inactive customer -> 400
`6250` "has been deleted"; a new customer may take the inactive one's original name.

### Evidence

- `src/explore/02-entity-shapes.ts`, run 2026-10-16. **verified**. `intuit_tid`s: duplicate
  name (case) `1-6ad22533-656fa0c441cf6196469ac5cf`; empty detail
  `1-6ad22535-1c9b3d6115005ce62bff264d`; ItemRef default
  `1-6ad22535-062c23d83fbbfce753233c0a`; 6070 `1-6ad22539-08dbbeb216323362057cd5cf`;
  rounding `1-6ad2253a-47e9bcab0e3389ed1b1c09cb`; tax computed
  `1-6ad22543-742b33f205985868601923a8`; tax not defaulted
  `1-6ad22540-3373e71062b1d5282b672dc7`; EUR ignored `1-6ad22547-088814d125eb66b4578eb9d0`;
  payment `1-6ad2254a-52e9fd7d01fe5dca2bb36c99`; invoice SyncToken bumped
  `1-6ad2254b-79c89583760121617af1ae9b`; deactivate with balance
  `1-6ad2254c-34d8f20d6ad2c03060449fb3`; "(deleted)" rename
  `1-6ad2254d-11a77ce231e7c66f296fe80c`; 6250 `1-6ad2254f-681fde322972c36220f923f1`.
- Records created: customers 60-63, invoices 156-173, payments 174-175 (all `EXPLORE-02-*`).

### Implications for the sync

- **Line mapping:** map only `SalesItemLineDetail` (and possibly `DescriptionOnly`) lines;
  drop `SubTotalLineDetail` on read. Always send an explicit `ItemRef` (one configured
  default service item) - relying on the silent "Services" fallback hides mistakes.
- **Money:** our amounts must be decimal cents; QBO rounds silently, so validate on our side
  and compare in cents. If we send `Qty` and `UnitPrice`, they must multiply exactly.
- **Tax:** QBO won't apply tax on its own via the API. Simplest honest scope: our invoices
  are tax-exclusive / tax-free (`NON`), stated as an assumption. If tax is needed, we send
  `TaxCodeRef` + `TxnTaxCodeRef` and must then read back QBO's `TotalAmt` - the total is
  computed by QBO, not by us.
- **Currency:** single currency (USD); reject non-USD on our side, since QBO won't.
- **DocNumber** is a usable shared business key: we can send our own invoice number
  (≤ 21 chars) - relevant to matching (area 12).
- **Customers:** need a customer mapping too (invoices can't exist without `CustomerRef`).
  Names collide case-insensitively, and a deactivated customer's name changes - don't use
  `DisplayName` as a stable key; store the QBO `Id`.
- **Payments touch invoices:** a payment applied in QBO bumps the invoice's `SyncToken`, so
  our next invoice update with a cached token will fail (area 3) - always re-read before
  writing. It also likely emits an invoice change event (verify in areas 7-8).

## 3. Create / update / SyncToken

### Summary

- **Optimistic locking:** every update needs the current `SyncToken`; a stale, future or
  missing token gives HTTP 400 **`5010` Stale Object Error** (message names the sandbox
  user: "You and Craig Carlson were working on this at the same time"). Of two concurrent
  updates with the same token exactly one wins. A string or numeric token both work.
- **Only real changes bump `SyncToken` and `LastUpdatedTime`.** A sparse update with no
  fields, a full update that resends the GET body unchanged, `CustomerMemo: null` and
  `DocNumber: ""` all return 200 with the token unchanged.
- **Sparse update (`"sparse": true`)** changes only the fields sent - **except `Line`: when
  `Line` is present it replaces the whole line list**, so lines not sent are deleted. To
  change one line you must send all of them.
- **Full update** (no `sparse`) resets every omitted field: `PrivateNote`, `CustomerMemo`,
  `BillEmail` are cleared, `DueDate` goes back to the terms default, **`TxnDate` resets to
  today**. `DocNumber` survives. Rule: full updates must start from a fresh GET.
- **Clearing fields:** `PrivateNote: ""` clears (sparse); `null` is ignored; `DocNumber: ""`
  is ignored (cannot clear DocNumber).
- **Line Ids:** kept by Id; lines without `Id` (or with an unknown `Id`, e.g. `99`) are
  added with a new Id = highest ever used + 1 - **Ids are never reused** after deletion.
  Reordering keeps Ids and renumbers `LineNum`. Sending the `SubTotalLineDetail` line back is
  harmless. `Line: []` is rejected (`2020`).
- `CustomerRef` can be changed on update (no payments linked; area 6 covers paid invoices).
- **Duplicate `DocNumber` is allowed** on create and on update - no error, no warning.
- **Rejected writes are atomic:** an update with one valid and one invalid change is fully
  rejected; nothing is applied.

### Details

Sequence on one invoice (`03-updates.ts`; line notation `Id:LineNum:Description:Amount`):

| Step                                                   | SyncToken | Lines after            |
|--------------------------------------------------------|-----------|------------------------|
| create A 10, B 20, C 30                                | 0         | 1:1:A, 2:2:B, 3:3:C    |
| sparse no-op; full no-op                               | 0, 0      | unchanged              |
| sparse `PrivateNote`                                   | +1        | unchanged              |
| sparse `PrivateNote: ""`                               | +1        | (note cleared)         |
| sparse `CustomerMemo: null`                            | unchanged | (memo kept)            |
| sparse `Line: [line 2 -> 25]`                          | +1        | **2:1:B2 only**        |
| full with only Id, SyncToken, CustomerRef, Line        | +1        | memo, email cleared, DueDate default |
| full: line 2 dropped, new line D                       | +1        | 4:1:D                  |
| full: + new line E                                     | +1        | 4:1:D, 5:2:E           |
| full: + line with unknown Id 99                        | +1        | ..., **6**:3:F         |
| full: reversed order                                   | +1        | 6:1:F, 5:2:E, 4:3:D    |
| full: resend incl. SubTotal line                       | unchanged |                        |
| full: `Line: []`                                       | 400 `2020`|                        |

`03b-synctoken.ts`: token 0 -> update -> 1; update with 0 again -> `5010` (`element: ""`);
numeric `1` -> 200; full update omitting `TxnDate` (was `2026-03-01`) -> `2026-10-16`.

Stale error body:

```json
{ "Fault": { "Error": [{ "Message": "Stale Object Error", "code": "5010", "element": "",
  "Detail": "Stale Object Error : You and Craig Carlson were working on this at the same time. Craig Carlson finished before you did, so your work was not saved." }],
  "type": "ValidationFault" } }
```

### Evidence

- `src/explore/03-updates.ts`, `src/explore/03b-synctoken.ts`, run 2026-10-16.
  **verified**. `intuit_tid`s: sparse no-op `1-6ad225b6-3644417b560fae633ea86981`; full
  no-op `1-6ad225b9-05e561611d19004b406b520c`; sparse Line replaces all
  `1-6ad225be-16361aff74a2d3366fb58e01`; full update clears
  `1-6ad225bf-42da9b0669d91a9134044254`; unknown line Id `1-6ad225c2-38b7771b42770d34743bf019`;
  duplicate DocNumber `1-6ad225c7-247e930d2132f95d09443d92`; race winner/loser
  `1-6ad225cb-01d165526f4040f263061938` / `1-6ad225cc-382d195e6c6993230f82342a`; atomic
  reject `1-6ad225cd-080e7b4031a75d787943ffc1`; stale `1-6ad225e9-0c7baa584fa4b4093f0e41d3`;
  TxnDate reset `1-6ad225eb-3379d5ed647f8e0f4c3cb3c4`.

### Implications for the sync

- **Write path = read-modify-write:** GET the invoice, apply our change to the fresh body,
  POST with its `SyncToken`. On `5010`, re-read and re-decide (the change may now be a
  conflict) - never blindly retry with a new token.
- `5010` is our natural conflict detector for writes to QBO; the race test shows QBO
  serialises correctly.
- **Always send the complete line list** (sparse or full) and send back QBO line `Id`s for
  lines that still exist; we need a mapping our-line -> QBO line Id, or we rewrite all lines
  each time (simpler; Ids then change every update - acceptable if nothing keys on them).
- Prefer **sparse** updates for header fields to avoid wiping fields we don't own
  (`BillEmail`, terms, and `TxnDate`).
- `SyncToken` / `LastUpdatedTime` only move on real changes, so "token changed since we last
  wrote" means someone (us or a human) really changed something - usable for echo detection
  (compare against the token our own write returned).
- QBO won't stop duplicate `DocNumber`s - if we use DocNumber as a matching key, uniqueness
  is our job.

## Gotchas

- "Not found" is HTTP 400 `ValidationFault` code `610`, not 404.
- 401 bodies use a different, lowercase envelope.
- `QueryResponse.totalCount` is the page size, not the total.
- Empty query result is `QueryResponse: {}`.
- Field-list queries return `Line: []` - looks like an invoice with no lines.
- `minorversion` is never validated; a typo silently gives version 75.
- `LastUpdatedTime` has one-second precision, and filter values are truncated to seconds.
- Every invoice has an extra `SubTotalLineDetail` line without an `Id`.
- `SalesItemLineDetail` without `ItemRef` silently becomes item "Services".
- Tax is not applied on API creates unless both line and transaction tax codes are sent.
- `CurrencyRef` is silently ignored when multicurrency is off.
- Amounts are silently rounded to cents.
- Deactivating a customer renames it `"... (deleted)"`; inactive records vanish from queries.
- Applying a payment bumps the invoice's `SyncToken`.
- A sparse update that includes `Line` deletes every line not sent.
- A full update resets omitted fields, including `TxnDate` (-> today) and `DueDate`.
- No-op updates don't bump `SyncToken` - "200 OK" doesn't mean anything changed.
- Duplicate `DocNumber`s are accepted silently.
- Line Ids are never reused; unknown line Ids are treated as new lines (no error).
- `null` in a sparse update is ignored; `""` clears (strings only; `DocNumber: ""` ignored).

## Open questions

- Default page size without `maxresults` (docs: 100) - not observable in this sandbox.
- 5xx shape - none seen so far (area 10).
- Whether minorversion changes *values* (not field sets) - not diffed.

## Minimal request bodies

All verified by `02-entity-shapes.ts`.

```jsonc
// POST /customer
{ "DisplayName": "Acme Ltd" }

// POST /invoice  (ItemRef 1 = "Services"; omit Qty/UnitPrice or make them multiply exactly)
{ "CustomerRef": { "value": "60" }, "DocNumber": "INV-0001",
  "Line": [{ "Amount": 100, "Description": "...", "DetailType": "SalesItemLineDetail",
             "SalesItemLineDetail": { "ItemRef": { "value": "1" } } }] }

// POST /payment
{ "CustomerRef": { "value": "60" }, "TotalAmt": 40,
  "Line": [{ "Amount": 40, "LinkedTxn": [{ "TxnId": "157", "TxnType": "Invoice" }] }] }
```

```jsonc
// POST /invoice  - sparse header update (only these fields change)
{ "Id": "157", "SyncToken": "3", "sparse": true, "PrivateNote": "..." }

// POST /invoice  - line change: send ALL lines; existing ones with their QBO Id
{ "Id": "157", "SyncToken": "4", "sparse": true,
  "Line": [{ "Id": "1", "Amount": 100, "DetailType": "SalesItemLineDetail", "SalesItemLineDetail": { "ItemRef": { "value": "1" } } },
           { "Amount": 50, "DetailType": "SalesItemLineDetail", "SalesItemLineDetail": { "ItemRef": { "value": "1" } } }] }
```
