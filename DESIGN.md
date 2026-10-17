# Design

Decisions for the two-way invoice sync, with the reasoning and the alternatives considered.
Requirements: `TASK.md`. Progress: `PROGRESS.md`.

## 1. System overview

The sync connects two systems: "our" invoicing system and QuickBooks Online (QBO).

- **The sync service** (this repo) - syncs the invoicing system with QBO. Receives change
  notifications from both sides, fetches current state, applies changes to the other side,
  keeps links between records and an audit log. Has its own database.
- **The invoicing system** - assumed, not built. The sync talks to it only through the
  contract in `docs/INVOICING.md` (API + change notifications); in tests an in-memory
  fake plays it.

```
  ┌───────────────────┐  webhooks  ┌──────────────────┐  webhooks  ┌───────┐
  │ invoicing system  │ ─────────► │   sync service   │ ◄───────── │  QBO  │
  │ (assumed; a fake  │ ◄───────── │  (own Postgres)  │ ─────────► │       │
  │  in tests)        │ API calls  └──────────────────┘ API calls  └───────┘
  └───────────────────┘
```

**Decision: the invoicing system is assumed and simulated, not built.**

- Why: the task assumes an existing internal system with an API and webhook-like
  notifications and evaluates the sync - idempotency, conflicts, reliability under
  partial failure, tests. Building a second service would spend effort outside that.
  An in-memory fake gives full control over the integration mess on that side
  (duplicate, delayed, reordered or lost events, timeouts after a write, stale versions),
  so edge cases are tested deterministically.
- What the sync may assume is written down as a contract (`docs/INVOICING.md`), close to
  QBO's model so records map one-to-one; the fake implements exactly that contract.
- Alternatives considered: a real invoicing service with its own database and UI (best
  for a click-through demo, but a large share of the work); the invoicing data as tables
  inside the sync service (simple, but it bypasses the API boundary and hides half of the
  problem the task is about).
- Cost: no hand-editable invoicing side at runtime. The demo runs scripted scenarios
  against the real QBO sandbox instead.

**Decision: the sync service is a separate process with its own database**, talking to
both systems only through their APIs and notifications.

- Why: treats both sides the same way, so failure cases (slow, down, duplicate delivery)
  apply to both and are tested on both.

**Decision: the sync service runs as one process with two roles** - an HTTP server
(webhook receivers, a read API for links, audit log and conflicts) and a background
worker (sync jobs).

- Why: enough for this scope; one thing to run and debug.
- Alternative: separate webhook receiver and worker processes, so they scale and fail
  independently. The design keeps them decoupled through the database (received events
  are stored first, processed later), so splitting them later is a deployment change, not
  a rewrite.

## 2. Repository structure

One package - the repo is the sync service:

```
src/                      the sync service
  qbo/                    QBO transport: OAuth, token refresh, requests (minor version,
                          requestid, timeout), raw responses; token storage pluggable
test/                     scenario tests, fakes (invoicing system, QBO), e2e
docs/INVOICING.md         the assumed invoicing contract
qbo-playground/           scripts to explore and verify QBO sandbox API behaviour, and
                          the findings (qbo-spec.md, sync-notes.md)
docker-compose.yml        Postgres
TASK.md  DESIGN.md  PROGRESS.md  README.md
```

**Decision: a single package, no workspaces.** With one service, workspaces and shared
packages add build and navigation overhead without a second consumer. The QBO client is
a module (`src/qbo`) that knows only QBO; the playground scripts import it directly, so
what the exploration verified is the code the sync runs.

**Decision: no UI.** The sync's state (links, audit log, conflicts) is exposed through a
small read API; the demo shows it through scenario output alongside the QBO web UI. A UI
would take effort from the sync and tests for little evaluated value.

**Naming:** our system is "invoicing", QuickBooks is "QBO". We avoid "internal" /
"external", which only make sense from one side; the two sides stay symmetric in code
and docs.

## 3. Stack

TypeScript on Node (Fastify), PostgreSQL via Kysely, Vitest, Docker Compose, pnpm.

- Why: matches the company's stack (TS / Node / SQL). Kysely keeps SQL visible and typed
  rather than hidden behind an ORM, which suits a task that evaluates data modeling.

## 4. Testing

What the sync must do is a scenario list, `test/SCENARIOS.md` (Given / When / Then,
`core` built first, `extra` after). Each scenario is a Vitest test; no Cucumber.

| Layer | What is real | What is faked | Runs in |
|---|---|---|---|
| Integration | the sync, its Postgres | invoicing, QBO | `pnpm test` |
| Invariants (property-based, `fast-check`) | same | same, with random delivery and failures | `pnpm test` |
| QBO contract | - | - | against the fake in `pnpm test`, the sandbox in `pnpm test:e2e` |
| e2e (scenarios marked ★) | the sync, its Postgres, QBO sandbox | invoicing | `pnpm test:e2e` |

**Decision: the fake QBO reproduces only what the scenarios rely on**, all verified in
the sandbox (`qbo-playground/qbo-spec.md`): `SyncToken` and stale-token errors,
`requestid` replay, void as a zeroed invoice with a "Voided -" note, delete ignoring
`SyncToken`, payments unapplied on void / delete / reduction, CDC with delete stubs,
non-unique `DocNumber`, id-only webhooks. It adds controls the real QBO lacks: hold,
duplicate, reorder or drop notifications; timeout after a write; 5xx, 429, 401. Not
reproduced: automatic credit application, tax and currency math, rate limiting. The
contract tests run the same checks against the fake and the sandbox, so the fake can't
drift from the real behaviour.

**Decision: a fresh database per test**, created from a template database that has
`db/baseline.sql` applied (one Testcontainers Postgres per run). Tests can't see each
other's data and test files run in parallel. Postgres is real because the sync's
guarantees rest on it: transactions, unique constraints, row locks.

**Decision: tests drive time and delivery; no sleeps.** Each test builds a world: the
real sync wired to both fakes, an injectable clock and its database. The test decides
when notifications are delivered (through the real webhook route, via Fastify `inject`),
runs the worker until the queue is empty (`drain`), triggers one polling cycle, and
advances the clock for backoff. This requires the sync to take all dependencies as
arguments and to have a worker that can drain and stop.

**Decision: preconditions are built through the sync itself.** "Given a linked invoice"
creates it in the fake invoicing system and runs the sync, so the starting state is what
the real code produces. Direct seeding is used only for states the sync can't produce,
such as records that existed on both sides before it was connected.

**Decision: ★ scenarios are written once and run in both worlds.** Assertions use only
what the fake and the sandbox both offer (e.g. "no second write" is an unchanged
`SyncToken`). In e2e:
- The test plays a person editing QBO through its own API client.
- QBO changes are picked up by polling (CDC) with a bounded wait, since live webhooks
  need a public URL and arrive with unpredictable delay. Webhook intake is covered by
  integration tests on recorded Intuit payloads.
- The shared sandbox can't be reset, so every run uses a unique name prefix, runs
  sequentially, and cleans up after itself (deletes invoices and payments; deactivates
  customers and items, which QBO can't delete).
- e2e needs the network and a QBO connection, so it stays out of `pnpm check`.

## 5. Sync

**Decision: the sync reconciles state; it doesn't replay events.** A notification only
means "look at record X". A sync job reads X's current state on both sides, compares
each with the pair's snapshot from the last successful sync, and per field:

| Changed in | Action |
|---|---|
| one side only | copy to the other side |
| both, to the same value | nothing (refresh the snapshot) |
| both, to different values | conflict |
| neither | nothing (an echo, a duplicate, a late event) |

- Why: duplicates, reordering, delays, incomplete payloads and lost webhooks all
  collapse into "look again"; none needs its own mechanism. A retry after partial
  success sees what is already done.
- Alternative: replaying events (apply "memo changed" to the other side). Needs dedup,
  ordering and buffering per case, and breaks on a lost or incomplete event.
- Cost: every job reads both sides; fine for this volume under QBO's ~10 requests/s.

### Intake

- Sources: QBO webhooks (signature verified), invoicing webhooks, and a periodic poll of
  both (QBO CDC, the invoicing events feed) from stored cursors. Webhooks are the fast
  path, polling the guarantee.
- One short transaction per notification: store it as received (for the audit), enqueue
  a job for the record unless one is already pending, answer 200.
- No dedup keys: duplicates merge into the pending job or, once processed, find nothing
  to do.
- Cursors advance in the same transaction as the jobs they enqueue. The CDC cursor steps
  back a few seconds (`changedSince` is exclusive and whole-second); records seen twice
  are harmless.

### Links and snapshots

- One link table for all linked types (account, item, customer, invoice, payment): the
  two ids, the snapshot, the invoicing `version` and QBO `SyncToken` it was taken at, and
  a state (active, deleted, parked). Unique per type and id on each side, so a record
  can't be linked twice.
- The snapshot is in a neutral form both sides map to: references point at links (a
  customer is "link 17", not `cus_42` or QBO `7`); money is decimal strings. Balances and
  payment status are not synced fields: each side derives them from payments.
- An invoice's lines are one field: any line change changes "lines", and a write resends
  all lines. Edits to different lines on both sides are therefore a conflict. Per-line
  merging would need line links, and QBO line ids change on every rewrite.
- Memo maps to QBO `CustomerMemo`; `PrivateNote` is left alone (QBO writes "Voided" there).

### Field ownership: tax

QBO adds sales tax to invoices saved in its UI, and the API can't reproduce that tax.
Tax is therefore QBO's field: imported into invoicing as an amount (`tax`, part of the
total), never written to QBO. A line or tax edit in invoicing on an invoice taxed in QBO
is flagged, since pushing the lines would recompute the tax to zero. Invoices created
in invoicing go to QBO untaxed. Whenever the QBO invoice already carries a tax code
(any UI save adds one), line writes resend it; QBO rejects them otherwise.

### Conflicts and other issues

- A conflict is one field changed differently on both sides, or a delete or void on one
  side against an edit on the other. Everything else merges.
- Conflicts are never resolved automatically: last-writer-wins depends on clocks of two
  systems and silently drops one edit; a fixed winning side is a business decision.
- Everything the sync won't decide alone is an **issue** with a kind: conflict,
  unsupported data, revived void, changed `DocNumber`, number taken, ambiguous match,
  taxed lines edited. An open issue parks the pair: nothing is written to it either way,
  while its recorded current versions keep updating. Payments of a parked invoice keep
  syncing (they don't touch its fields).
- An issue closes by itself when both sides become equal, or through the API: an
  operator picks a side, which is written through the normal write path.

### Writes

- **Create:** the link row is stored first, with one id and an idempotency key (uuid); every
  retry, in any job, reuses that key (`requestid` in QBO, `Idempotency-Key` in
  invoicing), so a timeout after the write can't create a duplicate - even for payments,
  which QBO can't search by any key of ours. The link's uniqueness stops two jobs from
  creating the same counterpart. A different intended write gets a new key
  (QBO replays the old response for a reused key and ignores the body); `425` means
  "in flight", retry with the same key.
- **Update:** sends the `SyncToken` / `version` just read; a stale one (`5010` / 409)
  means refetch and compare again.
- **Delete:** QBO's delete ignores `SyncToken`, so the sync re-reads right before
  deleting and treats a fresh change as delete-vs-edit. The remaining window is a QBO
  limitation.
- **Echo:** after a write the link stores the new snapshot and the returned `SyncToken`
  / `version`; the echo notification finds them unchanged and does nothing. A crash
  between the write and storing the snapshot heals on retry: both sides changed the
  same way, which is "nothing to do".

### Jobs

- The queue is a Postgres table; jobs are enqueued in the intake transaction and claimed
  with `FOR UPDATE SKIP LOCKED`. No separate broker.
- A job is about one record in one system. Notifications for a record merge into its
  pending job, and one job per record runs at a time (unique indexes). A running job
  holds a time-limited lease instead of a database lock across external calls; a
  crashed worker's job is picked up when the lease expires.
- Jobs for the two records of a pair may run at the same time. Correctness rests on
  version checks, which a lease can't replace anyway (a stalled worker can outlive it):
  writes carry `SyncToken` / `version`, the link is updated only at the version that was
  read, and a second link for a record is rejected by its unique index. A job that loses
  the race rereads and finds nothing to do.
- Dependencies are synced inside the job: a missing customer or item before the
  invoice, an unlinked invoice before its payment.
- Partial success needs no step tracking: each step stores its result (a link) as it
  goes, and a retry reconciles again and skips what is done.
- Retries: network errors, timeouts and 5xx with exponential backoff and jitter; 429
  after `retry-after`; 401 after a token refresh. Validation errors fail at once. After
  the attempt limit a job is failed, visible in the audit, and can be retried through
  the API. Few workers (config), to stay under QBO's rate limit.

### Void, delete and payments

- Void in QBO has no flag: an invoice with all lines zero and a `PrivateNote` starting
  with "Voided" is void; the webhook's `Void` operation is only a hint (CDC loses it).
  A voided invoice edited back to life in QBO is an issue (void is final in invoicing).
- A linked record answering `610` (or a CDC "Deleted" stub) is deleted; the link is
  closed and later events for it are only audited.
- Invoicing changes one record per operation, while QBO frees payments implicitly when
  an invoice is voided, deleted or reduced. Mirroring that, the sync first changes the
  payment's allocations, then the invoice.
- A payment's neutral form is customer, date, amount, deposit account and allocations
  (invoice, amount); a QBO payment void maps to a delete.
- QBO moves payments on its own (frees them, applies credit to a customer's next
  invoice). To the sync this is an ordinary payment edit: an invoice job also enqueues
  the payments its snapshot links, and CDC catches the rest.

### Records with no link

- Before creating anything, the sync looks for a counterpart: invoices by number
  (`DocNumber`, compared ignoring case) plus customer and total; customers, items and
  accounts by name. Exactly one match links the pair; a number held by a different
  invoice, or several candidates, is an issue.
- Fields that differ when a pair is first linked have no common past, so they open a
  conflict instead of a guess.
- `pnpm sync:reconcile` handles records that existed before the sync was connected and
  never change: it records the poll cursors, then enqueues a job for every record on
  both sides.

### Scope

- Single currency: the sandbox has multicurrency off, so QBO stores everything in USD;
  any other currency is still flagged.
- Inventory items, text-only lines and discount lines are flagged; QBO's computed
  subtotal line is ignored.

### Database

`db/baseline.sql`:

| Table | Holds |
|---|---|
| `invoicing_qbo_links` | pairs: both ids, the create idempotency key, snapshot, versions, deletion |
| `sync_jobs` | the queue: record, status, attempts, next run, lease, last error |
| `sync_issues` | what needs a person: record, link, kind, versions, resolution |
| `audit_log` | append-only: notifications received and every step taken, with field changes and outcome |
| `poll_cursors` | how far each system's changes have been read |

Jobs, issues and audit entries name their record by `system`, `entity_type` and `entity_id`, plus the link
once there is one; the history of a pair is its link's entries plus those of its two
records from before it was linked. Received notifications are audit entries rather than
a table of their own. "Parked" is not stored: a pair is parked while it has an open
issue.
