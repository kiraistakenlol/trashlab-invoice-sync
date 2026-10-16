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
  - and returns the same Invoice shape. Intuit made 75 the floor on 2025-08-01: anything
  below 75 (or missing) is served as 75. We keep sending `75` explicitly.
- **Envelope:** reads `{ <Entity>: {...}, time }`; queries `{ QueryResponse: { <Entity>: [...],
  startPosition, maxResults, totalCount }, time }`; errors `{ Fault: { Error: [...], type },
  time }`.
- **Errors are mostly HTTP 400 `ValidationFault`, including "not found"** (code `610`), not
  404. Classify by `Fault.Error[].code`, not by HTTP status.
- **401 (bad/expired token) has a completely different, lowercase envelope** (`fault.error[]`,
  `type: "AUTHENTICATION"`, code `3200`) plus `www-authenticate: Bearer ... error="invalid_token"`.
- **Query language:** SQL-like, single entity, `AND` only (`OR` is a parse error), `IN`,
  `LIKE 'x%'`, comparison on `MetaData.LastUpdatedTime` and amounts, `orderby`,
  `startposition` (1-based), `maxresults` ≤ 1000, `count(*)`.
- **`totalCount` is the number of rows in this page, not the grand total** - only
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

`where NoSuchField = 1` gives a misleading parse error ("expecting true/false"); with a
quoted value it gives the clear `4001 Property NoSuchField not found`.

Sandbox sizes at the time: 31 invoices, 29 customers, 18 items, 89 accounts.

### Evidence

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
  total available). Because timestamps have one-second precision, use `>=` with an overlap
  and rely on idempotent processing for the repeats.
- Never act on field-list query results; fetch full records.

## Gotchas

- "Not found" is HTTP 400 `ValidationFault` code `610`, not 404.
- 401 bodies use a different, lowercase envelope.
- `QueryResponse.totalCount` is the page size, not the total.
- Empty query result is `QueryResponse: {}`.
- Field-list queries return `Line: []` - looks like an invoice with no lines.
- `minorversion` is never validated; a typo silently gives version 75.
- `LastUpdatedTime` has one-second precision.

## Open questions

- Default page size without `maxresults` (docs: 100) - not observable in this sandbox.

## Minimal request bodies

(Filled in by areas 2-3.)
