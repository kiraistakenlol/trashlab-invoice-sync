# Design details

Decisions for two-way invoice sync: reasoning, alternatives considered.
Requirements: `assignment.md`. Dated decisions: `decision-log.md`.

## 1. System overview

Sync connect two systems: "our" invoicing system and QuickBooks Online (QBO).

- **Sync service** (this repo). Sync invoicing with QBO. Receive change notifications from
  both sides, fetch current state, apply changes to other side, keep links between records
  + audit log. Own database.
- **Invoicing system.** Assumed, not built. Sync talk to it only through contract in
  `docs/invoicing-api-contract.md` (API + change notifications). `invoicing-sim/`
  implement contract in memory: in process for tests, over HTTP for local runs + demo.

**Decision: invoicing system assumed + simulated, not built.**

- Why: task assume existing internal system with API + webhook-like notifications, and
  evaluate sync: idempotency, conflicts, reliability under partial failure, tests. Second
  service = effort outside that. In-memory fake give full control over integration mess on
  that side (duplicate, delayed, reordered, lost events; timeout after write; stale
  versions) → edge cases tested deterministically.
- What sync may assume = written contract (`docs/invoicing-api-contract.md`), close to
  QBO's model so records map one-to-one. Fake implement exactly that contract.
- Alternatives: real invoicing service with own DB + UI (best for click-through demo, but
  big share of work); invoicing data as tables inside sync service (simple, but bypass API
  boundary, hide half of problem task is about).
- One implementation, two uses: tests drive it in process (failures armed, clock injected);
  `pnpm invoicing:dev` serve same code over HTTP (no failures, each change sent once to
  sync's webhook, events feed = guarantee). Sync's HTTP client tested against that server
  → client + simulator read contract same way.
- Cost: simulator in memory only; restart lose its records (reset sync database too).

**Decision: sync service = separate process, own database.** Talk to both systems only
through APIs + notifications.

- Why: both sides treated same. Failure cases (slow, down, duplicate delivery) apply to
  both, tested on both.

**Decision: one process, two roles.** HTTP server (webhook receivers, read API for links,
audit log, issues, jobs) + background worker (sync jobs).

- Why: enough for scope. One thing to run, debug.
- Process also poll both systems every `POLL_INTERVAL_MS`. SIGINT/SIGTERM stop poll loop +
  worker, then close server + database.
- QBO tokens in JSON file (`QBO_CONNECTION_FILE`, written by `pnpm qbo:auth`). Fine for one
  process. Several instances need database-backed token store; pluggable `TokenStore`
  allow it.
- Alternative: separate webhook receiver + worker processes, scale + fail independently.
  Design keep them decoupled through database (received events stored first, processed
  later) → split later = deployment change, not rewrite.

## 2. Repository structure

One package. Repo = sync service:

```
src/                      the sync service; main.ts runs it, service.ts wires it
  qbo/                    QBO transport: OAuth, token refresh, requests (minor version,
                          requestid, timeout), raw responses; token storage pluggable;
                          typed entity operations
  invoicing/              the invoicing system's types, client interface, errors,
                          HTTP client
  store/                  repositories: links, jobs, issues, audit log, poll cursors
  sync/                   intake, polling, job worker, the reconcile engine, mappers
    specs/                per-entity rules (catalogue, invoice, payment)
  http/                   webhook receivers, health, read API
  cli/                    operator commands (database reset, initial reconciliation)
db/baseline.sql           the sync service's schema
invoicing-sim/            the invoicing contract in memory; HTTP server + runner for local use
demo/                     `pnpm demo`: end-to-end walk-through against service + sandbox
test/                     scenario tests, fake QBO, sandbox runs
qbo-playground/           scripts to explore and verify QBO sandbox API behaviour, and
                          the findings (qbo-spec.md, sync-notes.md)
docs/                     requirements, design, write-up, progress, the invoicing contract
```

**Decision: single package, no workspaces.** One service → workspaces + shared packages
add build + navigation overhead, no second consumer. QBO client = module (`src/qbo`), know
only QBO. Playground scripts import it directly → what exploration verified = code sync
run.

**Decision: no UI.** Sync state (links, audit log, issues, jobs) exposed through small read
API. `pnpm demo` print it next to QBO web UI. UI = effort taken from sync
+ tests, little evaluated value.

**Naming:** our system = "invoicing", QuickBooks = "QBO". No "internal" / "external": make
sense only from one side. Two sides stay symmetric in code + docs.

## 3. Stack

TypeScript on Node (Fastify), PostgreSQL via Kysely, Vitest, Docker Compose, pnpm.

- Why: match company stack (TS / Node / SQL). Kysely keep SQL visible + typed, not hidden
  behind ORM. Suit task that evaluate data modeling.

## 4. Testing

What sync must do = scenario list `test/SCENARIOS.md` (Given / When / Then, `core` built
first, `extra` after). Each scenario = Vitest test. No Cucumber. Property-based invariants
(`fast-check`) run 50 generated cases per property.

**Decision: fake QBO reproduce only what scenarios rely on**, all verified in sandbox
(`qbo-playground/qbo-spec.md`):
- `SyncToken` + stale-token errors
- `requestid` replay
- void as zeroed invoice with "Voided -" note
- delete ignoring `SyncToken`
- payments unapplied on void / delete / reduction
- CDC with delete stubs
- non-unique `DocNumber`
- id-only webhooks
- 8 % sales tax when line + transaction tax codes both sent
- rejection (6000) of line edits on taxed invoice without `TxnTaxCodeRef`

Add controls real QBO lack: hold, duplicate, reorder, drop notifications; timeout after
write; 5xx, 429, 401, 425; UI save that tax invoice lines; rewrite stored record into state
API can't produce here (foreign currency, discount line, inventory item). Not reproduced:
automatic credit application, currency math, rate limiting. Contract tests run same checks
against fake + sandbox → fake can't drift from real behaviour.

**Decision: fresh database per test.** Created from template database with
`db/baseline.sql` applied (one Testcontainers Postgres per run). Tests can't see each
other's data; test files run in parallel. Postgres real because sync guarantees rest on
it: transactions, unique constraints, row locks.

**Decision: tests drive time + delivery. No sleeps.** Each test build world: real sync
wired to both fakes, injectable clock, its database. Test decide when notifications
delivered (through real webhook route, via Fastify `inject`), run worker until queue empty
(`drain`), trigger one polling cycle, advance clock for backoff. Need sync to take all
dependencies as arguments + worker that can drain and stop.

**Decision: preconditions built through sync itself.** "Given a linked invoice" = create
in fake invoicing, run sync → starting state = what real code produce. Direct seeding only
for states sync can't produce, e.g. records existing on both sides before sync connected.

**Decision: ★ scenarios written once, run in both worlds.** Assertions use only what fake +
sandbox both offer (e.g. "no second write" = unchanged `SyncToken`). Sandbox world
(`createSandboxWorld`) differ from fake world four ways:
- Test play person editing QBO through own API client. `syncUntil` wait for expected state
  with bounded wait, run sync each round. QBO changes arrive only through CDC polling: live
  webhooks need public URL, arrive with unpredictable delay. Webhook intake covered by
  integration tests on recorded Intuit payloads.
- Shared sandbox can't reset → every world unique name prefix. Records sync pick up from
  others stay untouched.
- Each world remove own QBO records on close: invoices + payments deleted; customers,
  items, accounts (QBO can't delete) deactivated.
- Sandbox-only checks read QBO directly, e.g. General Ledger post invoice + its payment to
  mapped accounts (G2).

Sandbox project need network + QBO connection → stay out of `pnpm check`.

## 5. Sync

**Decision: sync reconcile state, not replay events.** Notification = "look at record X".
Sync job read X current state on both sides, compare each with pair snapshot from last
successful sync, per field:

| Changed in | Action |
|---|---|
| one side only | copy to other side |
| both, same value | nothing (refresh snapshot) |
| both, different values | conflict |
| neither | nothing (echo, duplicate, late event) |


### Intake

- Sources: QBO webhooks (signature verified), invoicing webhooks, periodic poll of both
  (QBO CDC, invoicing events feed) from stored cursors. Webhooks = fast path, polling =
  guarantee.
- One short transaction per notification: store as received (for audit), enqueue job for
  record unless one already pending, answer 200.
- No dedup keys. Duplicates merge into pending job, or once processed, find nothing to do.
- Cursors advance in same transaction as jobs they enqueue. CDC cursor = time of request,
  never record timestamp (sandbox records can be dated in future). Next read start few
  seconds earlier: cover clock skew + exclusive, whole-second `changedSince`. Response
  capped at 1000 records of an entity hold cursor at last update it returned. Records seen
  twice harmless.

### Links and snapshots

- One link table for all linked types (account, item, customer, invoice, payment): two ids,
  snapshot, invoicing `version` + QBO `SyncToken` it was taken at, when closed as deleted.
  Unique per type + id on each side → record can't be linked twice.
- Snapshot in neutral form both sides map to. References point at links (customer = "link
  17", not `cus_42` or QBO `7`). Money = decimal strings. Balances + payment status not
  synced fields: each side derive them from payments.
- Invoice lines = one field. Any line change change "lines"; write resend all lines. Edits
  to different lines on both sides → conflict. Per-line merge need line links; QBO line ids
  change on every rewrite.
- Memo map to QBO `CustomerMemo`. `PrivateNote` left alone (QBO write "Voided" there).

### Field ownership: tax

QBO add sales tax to invoices saved in its UI. API compute tax when line + transaction tax
codes sent, but can't reproduce UI tax on NON lines. So tax = QBO's field: imported into
invoicing as amount (`tax`, part of total), never written to QBO. Line or tax edit in
invoicing on invoice taxed in QBO → flagged (pushing lines would recompute tax to zero).
Invoice created in invoicing go to QBO untaxed; one carrying tax not created there,
flagged. QBO invoice already carry tax code (any UI save add one) → line writes resend it;
QBO reject them otherwise.

### Conflicts and other issues

- Conflict = one field changed differently on both sides, or delete / void one side vs
  edit other side. Everything else merge.
- Conflicts never resolved automatically.
- Everything sync won't decide alone = **issue** with kind: conflict, unsupported data,
  revived void, changed `DocNumber`, number taken, ambiguous match, taxed lines edited.
  Open issue park pair: nothing written either way; recorded current versions keep
  updating. Payments of parked invoice keep syncing (don't touch its fields).
- Issue close itself when both sides equal or both deleted.
- Operator close conflict with `PATCH /issues/{id}` `{ "resolution": "invoicing" | "qbo" }`.
  One transaction: losing side current fields + version become link snapshot, winner
  stored version cleared, issue resolved with that side (audited `issue_resolved`,
  `by: operator`), job queued. Job then copy winner through normal write path. Loser edited
  again before job run → changed against that snapshot too → job open new conflict, not
  overwrite. Delete vs edit resolve only to delete; void vs edit only to void. Other answer
  = `409 cannot_restore`, issue stay open. Other issue kinds (`409 not_conflict`) + resolved
  issues (`409 not_open`) can't resolve this way.
- Conflict raised because write can't go ahead (payment allocated to invoice voided or
  deleted other side; payments still allocated to invoice being voided or deleted in
  invoicing; details carry `blocked: true`) close only once data fixed. Picking side
  refused `409 blocked`, or `409 not_paired` for record with no counterpart yet.

### Writes

- **Create:** link row stored first, with one id + idempotency key (uuid). Every retry, any
  job, reuse key (`requestid` in QBO, `Idempotency-Key` in invoicing) → timeout after write
  can't make duplicate. Even for payments, which QBO can't search by any key of ours. Link
  uniqueness stop two jobs creating same counterpart. Different intended write get new key
  (QBO replay old response for reused key, ignore body). `425` = "in flight", retry same key.
- **Pending create fields:** before call, link snapshot hold fields being created; every
  retry send those → reused key always carry same body (invoicing reject different one,
  QBO silently replay old). Once created, snapshot = new record fields. Source edit made
  meanwhile then copied as ordinary update.
- **Adoption:** record with no link whose fields equal exactly one link's pending create
  fields = that create, landed while its job hadn't stored id yet (timeout, or new record
  notification racing job). Adopted into that link, not matched or copied back.
- **Update:** send `SyncToken` / `version` just read. Stale one (`5010` / 409) = refetch,
  compare again.
- **Delete:** QBO delete ignore `SyncToken` → sync re-read right before deleting, treat fresh
  change as delete-vs-edit. Remaining window = QBO limitation.
- **Echo:** after write, link store new snapshot + returned `SyncToken` / `version`. Echo
  notification find them unchanged, do nothing. Crash between write + storing snapshot heal
  on retry: both sides changed same way = "nothing to do".

### Jobs

- Queue = Postgres table. Jobs enqueued in intake transaction, claimed with
  `FOR UPDATE SKIP LOCKED`. No separate broker.
- Job about one record in one system. Notifications for record merge into its pending job;
  one job per record run at a time (unique indexes). Running job hold time-limited lease,
  not database lock across external calls. Crashed worker job picked up when lease expire.
- Job outcome stored only by claim that ran it. Lease expired + other worker took job →
  late outcome dropped.
- Jobs for two records of pair may run same time. Correctness rest on version checks; lease
  can't replace them anyway (stalled worker can outlive it): writes carry `SyncToken` /
  `version`, link updated only at version read, second link for record rejected by unique
  index. Job that lose race reread, find nothing to do.
- Dependencies synced inside job: missing customer or item before invoice, unlinked
  invoice before its payment.
- Partial success need no step tracking: each step store result (a link) as it go; retry
  reconcile again, skip what done.
- Retries: network errors, timeouts, 5xx with exponential backoff + jitter; 429 after
  `retry-after`; 401 after token refresh. Validation errors fail at once. After attempt
  limit, job failed. Failed jobs + last error visible through read API
  (`GET /jobs?status=failed`); every write attempt, with error, in audit.
  `PATCH /jobs/{id}` with `{ "status": "pending" }` retry failed job: attempts reset, due
  now. `409 already_pending` when record already has pending job, `409 not_failed`
  otherwise. Few workers (config), stay under QBO rate limit.

### Void, delete and payments

- QBO void has no flag. Invoice with all lines zero + `PrivateNote` starting "Voided" = void.
  Webhook `Void` operation only hint (CDC lose it). Voided invoice edited back to life in
  QBO → `revived_void` issue (void final in invoicing); invoicing stay void.
- Voided side compared on void flag only; other fields taken from snapshot (QBO zero lines,
  invoicing keep them). Void vs edit other side = conflict.
- Linked record answering `610` (or CDC "Deleted" stub) = deleted. Same for invoicing record
  with `deletedAt` (soft delete). Link closed; later events for it only audited.
- Invoicing change one record per operation; QBO free payments implicitly when invoice
  voided, deleted, reduced. Mirror that: before invoicing void, delete, or write lowering
  total below allocated, sync first reconcile linked payments allocated to invoice, then
  write invoice. Allocations still over new total after (unlinked payment, or its pair
  parked) block write: invoice flagged instead, stay parked until person free payment +
  make change in invoicing too. Issue then close itself.
- Payment never written to side where invoice it allocate to is voided or deleted (QBO
  would store it unapplied, no error; invoicing reject it). Payment flagged as conflict
  instead. Create blocked this way send nothing → pending fields dropped, next attempt
  create from source as it is then. Person remove allocation (or void free it in QBO) →
  payment sync, issue close itself.
- Payment neutral form: customer, date, amount, allocations (invoice, amount). QBO payment
  void map to delete. Invoicing has no deposit account → payments created in QBO land on
  its default (Undeposited Funds); account not synced.
- QBO move payments on own (free them, apply credit to customer's next invoice). To sync =
  ordinary payment edit, picked up when QBO report payment changed. CDC report it; webhook
  for it not verified (QBO send none for invoice a payment write change). So invoice job
  writing invoice to QBO also queue job (audited as notification, source `invoice`) for each
  payment whose link snapshot allocate to invoice. Credit QBO apply to customer's new
  invoice not covered by that re-queue (payment snapshot don't allocate to invoice yet):
  picked up through CDC / polling.

### Records with no link

- Before creating anything, sync look for counterpart: invoices by number (`DocNumber`,
  case-insensitive) + customer + total; customers, items, accounts by name. Exactly one
  match → link pair. Number held by different invoice, by several candidates, or more than
  once on either side (twin numbers ambiguous from both records) → issue.
- Fields differing when pair first linked have no common past → conflict, not guess.
- Records existing before sync connected + never change: handled by `pnpm sync:reconcile`.
  Record poll cursors (stored cursor never moved backward), then enqueue job for every
  record on both sides; running service work them off.

### Scope

- Only QBO Income accounts synced. Other accounts change with every posting → ignored
  (notifications audited, nothing else).
- Single currency: sandbox multicurrency off → QBO store everything USD. Any other currency
  still flagged.
- Inventory items, text-only lines, discount lines flagged. QBO computed subtotal line
  ignored.

### Known limits

- QBO delete ignore `SyncToken`: edit landing between re-read + delete lost with record.
- More than 1000 changes of one entity inside CDC step-back window stall cursor: each poll
  re-read same records (idempotent, nothing lost from them), newer changes arrive only by
  webhook. Capped response may also skip deletion stubs if QBO don't order them with rest;
  webhook still report those.
- Adoption need created record read back exactly as sent. Field QBO change on way (or two
  identical payments in flight) leave counterpart unlinked; matching after can raise
  spurious issue or, for payments, duplicate.
- Payment create timed out after landing in QBO, then void or delete of its invoice before
  retry → flagged, pending fields dropped. Landed QBO payment can't be adopted, may come
  back as second invoicing payment.
- QBO free deactivated record name only after short delay. Creating catalogue record under
  just-freed name fail `6240`, classified permanent → job fail, operator retry with
  `PATCH /jobs/:id`.
- QBO records inactive when sync connect not enumerated by `pnpm sync:reconcile`: plain QBO
  query return active records only.
- Source deleted after its create landed but before link stored new id → counterpart
  orphaned.

### Database

`db/baseline.sql`:

| Table | Holds |
|---|---|
| `invoicing_qbo_links` | pairs: both ids, the create idempotency key, snapshot, versions, deletion |
| `sync_jobs` | the queue: record, status, attempts, next run, lease, last error |
| `sync_issues` | what needs a person: record, link, kind, versions, resolution |
| `audit_log` | append-only: notifications received and every step taken, with field changes and any error |
| `poll_cursors` | how far each system's changes have been read |

Jobs, issues, audit entries name record by `system`, `entity_type`, `entity_id`; issue also
name link once one exists. Audit entry about record it happened to (one notified about, or
one written); pair history = entries of its two records. Received notifications = audit
entries, no own table. Action succeeded when entry has no error. "Parked" not stored: pair
parked while it has open issue.
