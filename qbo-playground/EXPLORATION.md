# QBO API exploration - tracker

Goal: learn how the QuickBooks Online (QBO) Accounting API **actually behaves** in our
sandbox and record it in **`qbo-playground/qbo-spec.md`**: a project-agnostic spec of the
API that anyone could use, with every claim verified against the sandbox, not taken from
memory or docs alone. Sync-specific design inputs that don't follow directly from the facts
go to **`qbo-playground/sync-notes.md`**, never into the spec.

This file tracks the work so it can be picked up by any session. Update it as you go.

## How to work

**Setup (already done):**
- `.env` (repo root) holds app config; `qbo-playground/.qbo-connection.json` holds realm
  id + tokens (refreshed automatically).
- If the refresh token is ever rejected: `pnpm -C qbo-playground auth` and open the printed
  URL (user signs in; never enter credentials on their behalf).
- Ad-hoc calls: `pnpm -C qbo-playground call GET /invoice/123`,
  `pnpm -C qbo-playground call query "select * from Invoice maxresults 5"`,
  `pnpm -C qbo-playground call POST /invoice '<json>' [requestId]`.
- Client: `packages/qbo-client` (transport only: OAuth, refresh, minorversion, requestid,
  timeout, raw response + `intuit_tid`). Fix or extend it there if something is missing -
  qbo-sync-service will use the same client.

**Rules:**
- Sandbox only. Never print or commit secrets (`.env`, `.qbo-connection.json`).
- Each experiment is a script: `qbo-playground/src/explore/NN-<topic>.ts`, runnable on its
  own, printing the requests and the relevant parts of the responses. Add an `explore`
  script entry to `package.json` if useful (e.g. `tsx src/explore/$1.ts`).
- Mark test records so they are recognisable: customer names and memos start with
  `EXPLORE-`. Do not modify or delete the sandbox's pre-existing records unless an
  experiment needs a record in a specific state - then create your own.
- Findings in `qbo-spec.md` are **verified** by default (script + `intuit_tid` in the
  spec's evidence index) or marked **docs** (from documentation, not verified - give the
  link). Note surprises and contradictions with the docs explicitly.
- The spec stays neutral: no "we", no sync design, no project names.
- After finishing an area: tick it below, add a line to the session log, commit.

## Status

| #  | Area                                   | Status      |
|----|----------------------------------------|-------------|
| 1  | Basics: versions, errors, query        | done        |
| 2  | Entity shapes                          | done        |
| 3  | Create / update / SyncToken            | done        |
| 4  | Idempotency (`requestid`)              | not started |
| 5  | Void vs delete                         | not started |
| 6  | Payments and balances                  | not started |
| 7  | Change data capture (CDC)              | not started |
| 8  | Webhooks (ngrok)                       | not started |
| 9  | Accounts, items, GL                    | not started |
| 10 | Limits and failure modes               | not started |
| 11 | Manual edits in the QBO UI             | not started |
| 12 | Matching existing records / our ids    | not started |

## Questions per area

### 1. Basics
- Which `minorversion` values are accepted? Current default/latest? What happens with none,
  or with an old one? (client defaults to 75 - confirm or change)
- Response envelope for reads, queries, writes. Error format: `Fault.type` values
  (ValidationFault, AuthenticationFault, SystemFault, ...), `Error.code`, HTTP status per
  type.
- Query language: `select *` vs field lists (CompanyInfo rejects field lists), `where` on
  `MetaData.LastUpdatedTime`, `orderby`, `maxresults` (max?), `startposition` paging,
  `count(*)`.
- Timestamps: format and timezone of `MetaData.CreateTime` / `LastUpdatedTime`; precision.

### 2. Entity shapes
- **Invoice:** full JSON of a real one. `Id`, `SyncToken`, `DocNumber` (auto-generated?
  custom numbers setting?), `TxnDate`, `DueDate`, `CustomerRef`, `Line` types
  (SalesItemLineDetail - is `ItemRef` required? DescriptionOnly, SubTotalLine), `Amount`
  vs `Qty * UnitPrice` validation, `TotalAmt`, `Balance`, `LinkedTxn`, `PrivateNote`,
  `CustomerMemo`, `CurrencyRef`, tax fields in a US sandbox (`TxnTaxDetail`, automated
  sales tax - does it change totals?), `MetaData`.
- **Customer:** minimal create; `DisplayName` uniqueness (error on duplicate?); delete
  not possible -> `Active=false`?
- **Payment:** `TotalAmt`, `Line[].LinkedTxn` to invoices, `UnappliedAmt`,
  `DepositToAccountRef`, payment method.
- **Item:** the default service item(s); `IncomeAccountRef`.
- Minimal valid bodies for creating Customer, Invoice, Payment (keep them in the spec).

### 3. Create / update / SyncToken
- Full update vs sparse update (`"sparse": true`): what is kept, what is cleared.
- Stale `SyncToken`: status, error code, message.
- Lines on update: omitted lines removed? lines without `Id` added? line `Id` stability.
- Does every update bump `SyncToken` and `LastUpdatedTime`, even with no real change?
- Duplicate `DocNumber`: allowed, warned, rejected?
- Updating a voided invoice; updating a deleted invoice.

### 4. Idempotency (`requestid`)
- Same `requestid`, same body, sent twice: second response (same Id? same body? status?).
- Same `requestid`, different body.
- Does it apply to update, delete, void? To payments?
- How long is a `requestid` remembered (minutes? hours?) - test what is practical.
- "Timeout after write": abort the client quickly (tiny `timeoutMs`) on a create, then
  retry with the same `requestid` - one record or two?
- Without `requestid`: confirm a retried create makes a duplicate.

### 5. Void vs delete
- Void (`POST /invoice?operation=void` with Id + SyncToken): resulting `TotalAmt`,
  `Balance`, lines, `PrivateNote`; is it still readable and queryable? Can it be edited or
  un-voided?
- Delete (`POST /invoice?operation=delete`): response; reading the Id afterwards; does
  query still return it?
- Delete an invoice that has a payment linked. Void an invoice that is partially paid.
- Void / delete a payment: effect on the invoice `Balance`.

### 6. Payments and balances
- Full payment, partial payment, two partial payments: invoice `Balance` and any status
  fields.
- Overpayment -> `UnappliedAmt`?
- Edit a payment amount; delete a payment -> balance restored?
- One payment applied to two invoices (shape; we plan to support one-to-one only).
- Edit an invoice so its total drops below the amount already paid: rejected? credit?
- Payment against a voided invoice.

### 7. Change data capture (CDC)
- `GET /cdc?entities=Invoice,Payment,Customer&changedSince=<iso>`: response shape.
- How deleted and voided records appear (status field?).
- Limits: max look-back (30 days?), max objects per response, ordering.
- Latency: how soon after a write does the change show up?

### 8. Webhooks (ngrok)
Needs user steps first (see "Webhook setup" below).
- Payload format actually delivered: legacy `eventNotifications[].dataChangeEvent` or the
  newer CloudEvents format? Exact fields (realm, entity name, id, operation,
  lastUpdated).
- Operations seen: Create, Update, Delete, Void, Merge, Emailed - which fire for invoices
  and payments?
- Signature: `intuit-signature` header = base64 HMAC-SHA256 of the raw body with the
  verifier token? Verify in code.
- Delivery: latency, batching (several events per request?), retries when we return
  non-2xx or time out, duplicates, ordering.
- Do our **own API writes** trigger webhooks back to us (echo)? Essential for loop
  prevention in the sync.
- Do edits in the QBO UI trigger them? Required response time?

### 9. Accounts, items, GL
The task requires mapping "general ledger entries and accounts".
- `Account` entity: types, the income and A/R accounts, create; delete not possible ->
  `Active=false`?
- How invoice lines reach the GL: `Item.IncomeAccountRef`; A/R posting.
- `JournalEntry`: create / update / delete shape; requirements (balanced lines, accounts).
- Reports API (`/reports/GeneralLedger`, `/reports/TrialBalance`) - read-only view of GL
  postings; useful for verifying sync results?
- Do Account / JournalEntry changes show up in CDC and webhooks?

### 10. Limits and failure modes
- Rate limits (documented: ~500 requests/min per realm, ~10 concurrent): what does a 429
  look like (headers, body)? Try a short burst.
- Expired / invalid access token: status and body (to detect "refresh and retry").
- Refresh token rotation: does each refresh return a new refresh token? Old one still
  valid?
- Server errors seen (5xx) and their shape.
- `/batch` endpoint (up to 30 operations): worth using? Partial failure shape.

### 11. Manual edits in the QBO UI
- Sandbox UI URL. Edit an invoice by hand: what changes (`SyncToken`,
  `LastUpdatedTime`, lines' Ids)? Webhook + CDC visible?
- What can a UI user do that the API cannot (or vice versa)?

### 12. Matching existing records / our ids
- Fields usable to match pre-existing invoices with no link: `DocNumber`, customer,
  amount, date - how reliable?
- Where can we store our own invoice id in QBO (custom fields - available in sandbox?
  `PrivateNote`, `DocNumber`)? Trade-offs.

## Webhook setup (user steps)

1. Install ngrok and authenticate it (`ngrok config add-authtoken ...`). A free static
   domain avoids re-registering the URL every restart.
2. Run the local receiver (to be written: `qbo-playground/src/webhook-server.ts`, logs raw
   headers + body to `qbo-playground/webhooks.log` (gitignored) and verifies the
   signature) and `ngrok http <port>`.
3. developer.intuit.com -> app -> Development -> **Webhooks**: set the endpoint to the
   ngrok HTTPS URL, select Invoice, Payment, Customer, Account, JournalEntry (and any
   other relevant entities), save.
4. Copy the **verifier token** into `.env` as `QBO_WEBHOOK_VERIFIER_TOKEN` (also add the
   key, empty, to `.env.example`).

## Output: `qbo-spec.md`

Organised by API topic, not by exploration area: test environment, request conventions,
errors (one merged code catalogue), query language, entities, writes, then sections for
idempotency, void/delete, payments, CDC, webhooks, limits, UI edits as they get verified.
Appendices: gotchas, minimal request bodies, open questions, evidence index (section ->
script -> `intuit_tid`s). When an area is finished, fold its facts into the matching
sections, update the "Coverage" line and the appendices.

## Session log

- 2026-10-16 - Tracker created. Sandbox connected (realm `9341458506606758`, "Sandbox
  Company US 28a6", 31 invoices / 29 customers pre-existing). Found so far: `CompanyInfo`
  query accepts `select *` only.
- 2026-10-16 - Area 1 done (`01-basics.ts`). Key facts: any minorversion accepted (75 is the
  floor), not-found is 400/`610`, 401 has a different envelope, `totalCount` is page size,
  field-list queries return empty `Line`. Client: `minorVersion: null` omits the param.
- 2026-10-16 - Area 1 gaps filled (`01b-query-edges.ts`): timestamp filters truncate to
  seconds, operators, paging edges, case-insensitivity, default order.
- 2026-10-16 - Area 2 done (`02-entity-shapes.ts`). Key facts: tax not defaulted on API
  creates, missing ItemRef -> "Services", SubTotal line added, deactivated customer renamed
  "(deleted)", applying a payment bumps the invoice SyncToken, EUR silently ignored.
- 2026-10-16 - Area 3 done (`03-updates.ts`, `03b-synctoken.ts`). Key facts: stale token
  -> 400 `5010`; no-op updates don't bump SyncToken; sparse `Line` replaces all lines; full
  update resets TxnDate/DueDate and clears omitted fields; duplicate DocNumber allowed;
  line Ids never reused. Updating voided/deleted invoices moved to area 5.
- 2026-10-16 - Spec restructured: project-agnostic, by API topic, merged error catalogue,
  evidence index. Sync-specific notes moved to `sync-notes.md`.
