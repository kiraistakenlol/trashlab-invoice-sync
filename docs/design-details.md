# Design details

The decisions behind the two-way invoice sync, with their reasoning and the alternatives
considered. Requirements: `assignment.md`. Dated decisions: `decision-log.md`.

## 1. System overview

The sync connects two systems: "our" invoicing system and QuickBooks Online (QBO).

- **Sync service** (this repo). Receives change notifications from both sides, fetches
  current state, applies changes to the other side, and keeps the links between records
  and an audit log in its own database.
- **Invoicing system.** Assumed, not built. The sync talks to it only through the contract
  in `docs/invoicing-api-contract.md` (API and change notifications). `invoicing-sim/`
  implements that contract in memory: in process for tests, over HTTP for local runs and
  the demo.

**Decision: the invoicing system is assumed and simulated, not built.**

- Why: the task assumes an existing internal system with an API and webhook-like
  notifications, and evaluates the sync: idempotency, conflicts, reliability under partial
  failure, tests. A second service is effort spent outside that. An in-memory
  implementation gives full control over the integration mess on that side (duplicate,
  delayed, reordered and lost events; timeout after write; stale versions), so edge cases
  are tested deterministically.
- What the sync may assume is the written contract, kept close to QBO's model so records
  map one-to-one. The simulator implements exactly that contract.
- Alternatives: a real invoicing service with its own database and UI (best for a
  click-through demo, but a large share of the work); invoicing data as tables inside the
  sync service (simple, but it bypasses the API boundary and hides half of the problem).
- One implementation, two uses: tests drive it in process (failures armed, clock
  injected); `pnpm invoicing:dev` serves the same code over HTTP (no failures, each change
  sent once to the sync's webhook, the events feed as the guarantee). The sync's HTTP
  client is tested against that server, so client and simulator read the contract the
  same way.
- Cost: the simulator keeps its records in memory only; after a restart the sync database
  must be reset too.

**Decision: the sync is a separate process with its own database**, talking to both
systems only through their APIs and notifications.

- Why: both sides are treated the same, so failure cases (slow, down, duplicate delivery)
  apply to both and are tested on both.

**Decision: one process, two roles:** an HTTP server (webhook receivers; read API for links,
audit, issues and jobs) and a background worker (sync jobs).

- Why: enough for the scope; one thing to run and debug.
- The process also polls both systems every `POLL_INTERVAL_MS`. SIGINT / SIGTERM stop the
  poll loop and the worker, then close the server and the database.
- QBO tokens live in a JSON file (`QBO_CONNECTION_FILE`, written by `pnpm qbo:auth`), which
  is fine for one process. Several instances would need a database-backed token store;
  `TokenStore` is pluggable.
- Alternative: separate webhook receiver and worker processes that scale and fail
  independently. They are already decoupled through the database (notifications stored
  first, processed later), so splitting them is a deployment change, not a rewrite.

## 2. Repository structure

One package; the repo is the sync service:

```
src/                      the sync service; main.ts runs it, service.ts wires it
  qbo/                    QBO transport: OAuth, token refresh, requests (minor version,
                          requestid, timeout), raw responses; pluggable token storage;
                          typed entity operations
  invoicing/              the invoicing system's types, client interface, errors,
                          HTTP client
  store/                  repositories: links, jobs, issues, audit log, poll cursors
  sync/                   intake, polling, job worker, the reconcile engine, mappers
    specs/                per-entity rules (catalogue, invoice, payment)
  http/                   webhook receivers, health, read API
  cli/                    operator commands (database reset, initial reconciliation)
db/baseline.sql           the sync service's schema
invoicing-sim/            the invoicing contract in memory; HTTP server and runner
demo/                     `pnpm demo`: end-to-end walk-through against the service and sandbox
test/                     scenario tests, fake QBO, sandbox runs
qbo-playground/           scripts that explore and verify QBO sandbox behaviour, and the
                          findings (qbo-spec.md, sync-notes.md)
docs/                     requirements, design, write-up, requirements coverage, how it was
                          built, decision log, the invoicing contract
```

**Decision: a single package, no workspaces.** With one service, workspaces and shared
packages add build and navigation overhead with no second consumer. The QBO client is a
module (`src/qbo`) that knows only QBO; playground scripts import it directly, so what the
exploration verified is the code the sync runs.

**Decision: no UI.** Sync state (links, audit log, issues, jobs) is exposed through a small
read API, and `pnpm demo` prints it next to the QBO web UI. A UI would take effort from the
sync and its tests for little evaluated value.

**Naming:** our system is "invoicing", QuickBooks is "QBO". No "internal" / "external",
which only make sense from one side; the two sides stay symmetric in code and docs.

## 3. Stack

TypeScript on Node (Fastify), PostgreSQL via Kysely, Vitest, Docker Compose, pnpm.

- Why: it matches the company's stack (TS / Node / SQL). Kysely keeps SQL visible and
  typed instead of hiding it behind an ORM, which suits a task that evaluates data modeling.

## 4. Testing

What the sync must do is the scenario list `test/SCENARIOS.md` (Given / When / Then; `core`
built first, `extra` after). Each scenario is a Vitest test; no Cucumber. Property-based
invariants (`fast-check`) run 50 generated cases per property.

**Decision: the fake QBO reproduces only what the scenarios rely on**, all verified on the
sandbox (`qbo-playground/qbo-spec.md`):

- `SyncToken` and stale-token errors
- `requestid` replay
- void as a zeroed invoice with a "Voided -" note
- delete ignoring `SyncToken`
- payments unapplied on void, delete and reduction
- CDC with delete stubs
- non-unique `DocNumber`
- id-only webhooks
- 8 % sales tax when both line and transaction tax codes are sent
- rejection (6000) of line edits on a taxed invoice without `TxnTaxCodeRef`

It adds controls real QBO lacks: hold, duplicate, reorder and drop notifications; timeout
after write; 5xx, 429, 401, 425; a UI save that taxes invoice lines; rewriting a stored
record into a state the API can't produce here (foreign currency, discount line, inventory
item). Not reproduced: automatic credit application, currency math, rate limiting. Contract
tests run the same checks against the fake and the sandbox, so the fake can't drift.

**Decision: a fresh database per test**, created from a template database with
`db/baseline.sql` applied (one Testcontainers Postgres per run). Tests can't see each
other's data and test files run in parallel. Postgres is real because the sync's
guarantees rest on it: transactions, unique constraints, row locks.

**Decision: tests drive time and delivery; no sleeps.** Each test builds a world: the real
sync wired to both fakes, an injectable clock and its own database. The test decides when
notifications are delivered (through the real webhook route, via Fastify `inject`), runs
the worker until the queue is empty (`drain`), triggers a polling cycle and advances the
clock for backoff. This requires the sync to take all dependencies as arguments, and a
worker that can drain and stop.

**Decision: preconditions are built through the sync itself.** "Given a linked invoice"
means: create it in the fake invoicing and run the sync, so the starting state is what the
real code produces. Direct seeding is used only for states the sync can't produce, such as
records existing on both sides before the sync was connected.

**Decision: ★ scenarios are written once and run in both worlds.** Assertions use only what
the fake and the sandbox both offer (e.g. "no second write" = unchanged `SyncToken`). The
sandbox world (`createSandboxWorld`) differs from the fake world in four ways:

- The test plays a person editing QBO through its own API client; `syncUntil` waits for the
  expected state with a bounded wait, running the sync each round. QBO changes arrive only
  through CDC polling, because live webhooks need a public URL and arrive with unpredictable
  delay; webhook intake is covered by integration tests on recorded Intuit payloads.
- The shared sandbox can't be reset, so every world uses a unique name prefix. Records the
  sync picks up from others are left untouched.
- Each world removes its own QBO records on close: invoices and payments are deleted;
  customers, items and accounts (which QBO can't delete) are deactivated.
- Sandbox-only checks read QBO directly, e.g. that the General Ledger posts an invoice and
  its payment to the mapped accounts (G2).

The sandbox project needs the network and a QBO connection, so it stays out of `pnpm check`.

## 5. Sync

**Decision: the sync reconciles state, not replays events.** A notification means "look at
record X". The job reads X's current state on both sides and compares each field with the
pair's snapshot from the last successful sync:

| Changed in | Action |
|---|---|
| one side only | copy to the other side |
| both, same value | nothing (refresh the snapshot) |
| both, different values | conflict |
| neither | nothing (echo, duplicate, late event) |

### Intake

- Sources: QBO webhooks (signature verified), invoicing webhooks, and a periodic poll of
  both (QBO CDC, invoicing events feed) from stored cursors. Webhooks are the fast path,
  polling is the guarantee.
- One short transaction per notification: record it as received (for the audit), enqueue a
  job for the record unless one is already pending, answer 200.
- No dedup keys. A duplicate merges into the pending job or, once that has run, finds
  nothing to do.
- Cursors advance in the same transaction as the jobs they enqueue. The CDC cursor is the
  request time, never a record timestamp (sandbox records can be dated in the future). The
  next read starts a few seconds earlier to cover clock skew and the exclusive,
  whole-second `changedSince`. A response capped at 1000 records of an entity holds the
  cursor at the last update it returned. Records seen twice are harmless.

### Links and snapshots

- One link table for all linked types (account, item, customer, invoice, payment): both
  ids, the snapshot, the invoicing `version` and QBO `SyncToken` it was taken at, and when
  it was closed as deleted. Unique per type and id on each side, so a record can't be
  linked twice.
- The snapshot is in the neutral form both sides map to. References point at links (a
  customer is "link 17", not `cus_42` or QBO `7`); money is a decimal string. Balances and
  payment status are not synced fields: each side derives them from payments.
- Invoice lines are one field: any line change changes "lines", and a write resends all
  lines. Edits to different lines on both sides are a conflict. Per-line merging would
  need line links, and QBO line ids change on every rewrite.
- The memo maps to QBO `CustomerMemo`. `PrivateNote` is left alone (QBO writes "Voided"
  there).

### Field ownership: tax

QBO adds sales tax to invoices saved in its UI. The API computes tax when line and
transaction tax codes are sent, but can't reproduce UI tax on NON lines. So tax is QBO's
field: imported into invoicing as an amount (`tax`, part of the total) and never written to
QBO. A line or tax edit in invoicing on an invoice QBO taxed is flagged (pushing the lines
would recompute the tax to zero). Invoices created in invoicing go to QBO untaxed; one that
carries tax is not created there but flagged. When a QBO invoice already carries a tax code
(any UI save adds one), line writes resend it, because QBO rejects them otherwise.

### Conflicts and other issues

- A conflict is one field changed differently on both sides, or a delete or void on one
  side against an edit on the other. Everything else merges.
- Conflicts are never resolved automatically.
- Everything the sync won't decide alone is an **issue** with a kind: conflict,
  unsupported data, revived void, changed `DocNumber`, number taken, ambiguous match, taxed
  lines edited. An open issue parks the pair: nothing is written either way, while the
  recorded current versions keep updating. Payments of a parked invoice keep syncing (they
  don't touch its fields).
- An issue closes itself when both sides are equal or both deleted.
- An operator closes a conflict with `PATCH /issues/{id}` `{ "resolution": "invoicing" |
  "qbo" }`. In one transaction, the losing side's current fields and version become the
  link snapshot, the winner's stored version is cleared, the issue is resolved with that
  side (audited `issue_resolved`, `by: operator`) and a job is queued. The job then copies
  the winner through the normal write path. If the loser is edited again before the job
  runs, it has changed against that snapshot too, so the job opens a new conflict instead
  of overwriting. Delete vs edit resolves only to the delete, void vs edit only to the void;
  the other answer is `409 cannot_restore` and the issue stays open. Other issue kinds
  (`409 not_conflict`) and resolved issues (`409 not_open`) can't be resolved this way.
- A conflict raised because a write can't go ahead (a payment allocated to an invoice voided
  or deleted on the other side; payments still allocated to an invoice being voided or
  deleted in invoicing; details carry `blocked: true`) closes only once the data is fixed.
  Picking a side is refused with `409 blocked`, or `409 not_paired` for a record that has no
  counterpart yet.

### Writes

- **Create:** the link row is stored first, with one id and an idempotency key (uuid).
  Every retry, from any job, reuses the key (`requestid` in QBO, `Idempotency-Key` in
  invoicing), so a timeout after a write can't make a duplicate, even for payments, which
  QBO can't search by any key of ours. Link uniqueness stops two jobs creating the same
  counterpart. A different intended write gets a new key (QBO replays the old response for
  a reused key and ignores the body). `425` means "in flight": retry with the same key.
- **Pending create fields:** before the call, the link snapshot holds the fields being
  created and every retry sends those, so a reused key always carries the same body
  (invoicing rejects a different one; QBO silently replays the old). Once created, the
  snapshot is the new record's fields; a source edit made meanwhile is then copied as an
  ordinary update.
- **Adoption:** an unlinked record whose fields equal exactly one link's pending create
  fields is that create, landed while its job hadn't stored the id yet (a timeout, or the
  new record's notification racing the job). It is adopted into that link, not matched or
  copied back.
- **Update:** sends the `SyncToken` / `version` just read. A stale one (`5010` / 409) means
  refetch and compare again.
- **Delete:** QBO delete ignores `SyncToken`, so the sync re-reads right before deleting and
  treats a fresh change as delete vs edit. The remaining window is a QBO limitation.
- **Echo:** after a write the link stores the new snapshot and the returned `SyncToken` /
  `version`, so the echo notification finds them unchanged and does nothing. A crash
  between the write and storing the snapshot heals on retry: both sides changed the same
  way, so there is nothing to do.

### Jobs

- The queue is a Postgres table. Jobs are enqueued in the intake transaction and claimed
  with `FOR UPDATE SKIP LOCKED`; no separate broker.
- A job is about one record in one system. Notifications for a record merge into its
  pending job, and one job per record runs at a time (unique indexes). A running job holds
  a time-limited lease, not a database lock across external calls; a crashed worker's job
  is picked up when the lease expires.
- A job's outcome is stored only by the claim that ran it: if the lease expired and another
  worker took the job, the late outcome is dropped.
- Jobs for the two records of a pair may run at the same time. Correctness rests on version
  checks, which a lease couldn't replace anyway (a stalled worker can outlive it): writes
  carry `SyncToken` / `version`, the link is updated only at the version read, and a second
  link for a record is rejected by the unique index. The job that loses the race re-reads
  and finds nothing to do.
- Dependencies are synced inside the job: a missing customer or item before its invoice,
  an unlinked invoice before its payment.
- Partial success needs no step tracking: each step stores its result (a link) as it goes,
  and a retry reconciles again, skipping what is done.
- Retries: network errors, timeouts and 5xx with exponential backoff and jitter; 429 after
  `retry-after`; 401 after a token refresh; token endpoint failures too, except a refused
  grant or client (400 / 401, which needs new consent). Validation errors fail at once.
  After the attempt limit the job is failed. Failed jobs and their last error are visible
  through the read API (`GET /jobs?status=failed`); every write attempt is in the audit
  with its error, and every failed job attempt is audited as `attempt_failed` (error,
  attempt, failure class, retry time or failed). `PATCH /jobs/{id}` with
  `{ "status": "pending" }` retries a failed job (attempts reset, due now): `409
  already_pending` when the record already has a pending job, `409 not_failed` otherwise. A
  few workers (configurable) stay under the QBO rate limit.

### Void, delete and payments

- A QBO void has no flag: an invoice with all lines zero and a `PrivateNote` starting
  "Voided" is a void. The webhook `Void` operation is only a hint (CDC loses it). A voided
  invoice edited back to life in QBO raises a `revived_void` issue (void is final in
  invoicing), and invoicing stays void.
- A voided side is compared on the void flag only; other fields are taken from the snapshot
  (QBO zeroes the lines, invoicing keeps them). Void vs an edit on the other side is a
  conflict.
- A linked record answering `610` (or a CDC "Deleted" stub) is deleted, as is an invoicing
  record with `deletedAt` (soft delete). The link is closed; later events for it are only
  audited.
- A record is gone only on those answers or an invoicing `404`. A success response without
  the record (no `data`, no entity, a body that isn't JSON) is a transient failure and is
  retried, so a broken response can't delete the counterpart.
- Invoicing changes one record per operation, while QBO frees payments implicitly when an
  invoice is voided, deleted or reduced. To mirror that, before an invoicing void, delete or
  write that lowers the total below what is allocated, the sync first reconciles the linked
  payments allocated to the invoice, then writes the invoice. Allocations still over the new
  total afterwards (an unlinked payment, or one whose pair is parked) block the write: the
  invoice is flagged instead and stays parked until a person frees the payment and makes
  the change in invoicing too; the issue then closes itself.
- A payment is never written to a side where the invoice it allocates to is voided or
  deleted (QBO would store it unapplied without an error; invoicing rejects it). The payment
  is flagged as a conflict instead. A create blocked this way sends nothing, so its pending
  fields are dropped and the next attempt creates from the source as it is then. Once a
  person removes the allocation (or a void frees it in QBO), the payment syncs and the issue
  closes itself.
- Payment neutral form: customer, date, amount, allocations (invoice, amount). A QBO payment
  void maps to a delete. Invoicing has no deposit account, so payments created in QBO land
  on its default (Undeposited Funds); the account is not synced.
- QBO moves payments on its own (frees them, applies credit to the customer's next
  invoice). To the sync that is an ordinary payment edit, picked up when QBO reports the
  payment changed. CDC reports it; a webhook for it is not verified (QBO sends none for an
  invoice a payment write changes). So an invoice job that writes an invoice to QBO also
  queues a job (audited as a notification, source `invoice`) for each payment whose link
  snapshot allocates to that invoice. Credit QBO applies to a customer's new invoice isn't
  covered by that re-queue (the payment snapshot doesn't allocate to the invoice yet); it is
  picked up through CDC polling.

### Records with no link

- Before creating anything, the sync looks for a counterpart: invoices by number
  (`DocNumber`, case-insensitive) + customer + total; customers, items and accounts by
  name. Exactly one match links the pair. A number held by a different invoice, by several
  candidates, or more than once on either side (twin numbers are ambiguous from both
  records) raises an issue.
- Payments share no key, so they match on customer + amount + allocations among unlinked
  payments only (a second identical payment made later is created, not flagged). A
  candidate equal to a link's pending create fields is that create, landed early, and is
  left to its link. Candidates with the same date are linked; identical payments are
  interchangeable, so several pair off by id. Otherwise exactly one candidate, with no
  other like payment on its own side, is linked and a date difference is a conflict; more
  candidates raise `ambiguous_match`. The date is left out of the key because a payment
  entered by hand on the other side often carries a different date, and a duplicate
  payment is worse than a conflict.
- Fields that differ when a pair is first linked have no common past: a conflict, not a
  guess.
- Records that existed before the sync was connected and never change are handled by `pnpm
  sync:reconcile`: it records the poll cursors (a stored cursor never moves backward), then
  enqueues a job for every record on both sides for the running service to work off.

### Scope

- Only QBO Income accounts are synced. Other accounts change with every posting and are
  ignored (notifications audited, nothing else).
- Single currency: the sandbox has multicurrency off, so QBO stores everything in USD. Any
  other currency is still flagged.
- Inventory items, text-only lines and discount lines are flagged. QBO's computed subtotal
  line is ignored.

### Known limits

- No auth on the invoicing webhook or the operator API (a trusted network is assumed).
  Production: an HMAC signature on the invoicing webhook (like QBO's) and a bearer token on
  the operator API.
- QBO delete ignores `SyncToken`: an edit landing between the re-read and the delete is
  lost with the record.
- More than 1000 changes of one entity inside the CDC step-back window stall the cursor:
  each poll re-reads the same records (idempotent, nothing lost from them) and newer changes
  arrive only by webhook. A capped response may also skip deletion stubs if QBO doesn't
  order them with the rest; webhooks still report those.
- Adoption needs the created record to read back exactly as sent. A field QBO changes on the
  way (or two identical payments in flight) leaves the counterpart unlinked; matching it
  afterwards can raise a spurious issue or, for payments, a duplicate.
- A payment create that timed out after landing in QBO, followed by a void or delete of its
  invoice before the retry, is flagged and its pending fields dropped. The landed QBO
  payment can't be adopted and may come back as a second invoicing payment.
- QBO frees a deactivated record's name only after a short delay. Creating a catalogue
  record under a just-freed name fails with `6240`, classified permanent: the job fails and
  an operator retries it with `PATCH /jobs/:id`.
- QBO records already inactive when the sync connects are not enumerated by `pnpm
  sync:reconcile`: a plain QBO query returns active records only.
- A source deleted after its create landed but before the link stored the new id leaves the
  counterpart orphaned.

### Database

`db/baseline.sql`:

| Table | Holds |
|---|---|
| `invoicing_qbo_links` | pairs: both ids, the create idempotency key, snapshot, versions, deletion |
| `sync_jobs` | the queue: record, status, attempts, next run, lease, last error |
| `sync_issues` | what needs a person: record, link, kind, versions, resolution |
| `audit_log` | append-only: notifications received and every step taken, with field changes and any error |
| `poll_cursors` | how far each system's changes have been read |

Jobs, issues and audit entries name a record by `system`, `entity_type`, `entity_id`; an
issue also names the link once one exists. An audit entry is about the record it happened to
(the one notified about, or the one written); a pair's history is the entries of its two
records. Received notifications are audit entries with no table of their own. An action
succeeded when its entry has no error. "Parked" is not stored: a pair is parked while it
has an open issue.
