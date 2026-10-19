# How the work went

Order work done in, why each step came where it did. What decided:
[`design-writeup.md`](design-writeup.md). Full detail: [`design-details.md`](design-details.md).
Dated decisions: [`decision-log.md`](decision-log.md). Git history follow same steps.

## 1. Pin down the task

Task page + assignment email copied word for word into [`assignment.md`](assignment.md).
That file = one reference for every later decision. Email set priority: correct handling
of real integration mess before number of features.

## 2. Learn how QBO really behave before designing anything

Sync only as correct as its picture of other system. QBO docs leave out much that matter
for sync. So first code = small QBO client (OAuth, token refresh, raw requests) + scripts
running experiments against real sandbox. Twelve areas checked:

- errors + query language
- entity shapes
- updates + `SyncToken`
- idempotency (`requestid`)
- void + delete
- payments + balances
- change data capture (CDC)
- webhooks
- accounts + general ledger
- limits + tokens
- finding records
- edits made in QBO web UI

Results → [`qbo-playground/qbo-spec.md`](../qbo-playground/qbo-spec.md). Facts only, each
with request that proved it. What facts mean for sync → separate file,
`qbo-playground/sync-notes.md`.

Later decisions straight from this step:

- Void = zeroed invoice + note, not flag.
- Delete ignore `SyncToken`.
- QBO silently unapply payments when invoice voided or reduced.
- Invoices saved in UI get sales tax.
- `DocNumber` not unique.
- One sandbox record dated in future → break naive CDC cursor.

## 3. Decide what to build, and what not

First plan: three apps (invoicing service, sync, UI). After QBO work, cut to one:

- **Invoicing system assumed, not built.** Task say it exist. Building it = time outside
  what evaluated. Instead: contract written down
  ([`docs/invoicing-api-contract.md`](invoicing-api-contract.md)), close to QBO model so
  records map one to one; in-memory fake play it in tests.
- **No UI.** Sync state exposed through small API. Demo run real scenarios against sandbox.
- **One package, not monorepo.** One service only → workspaces only add overhead.

## 4. Write scenarios before design

Before deciding how sync work, list of what it must handle written as Given / When / Then
in [`test/SCENARIOS.md`](../test/SCENARIOS.md). Cover every task edge case + QBO quirks
from step 2:

- duplicates, out-of-order, lost events
- edits on both sides
- void vs delete
- partially paid invoices
- timeout after write
- records on both sides with no link
- tax + general ledger

Each scenario marked `core` (asked directly) or `extra`. ★ ones must also pass on real
sandbox.

Design then had to answer every scenario. That how central decision reached: reconcile
current state, not replay events. Almost every case reduce to "look at record again" → no
separate mechanism per case.

## 5. Decide how to test it

Test approach fixed before any sync code:

- Real sync + real Postgres against two fakes. Each test control notification delivery
  (duplicate, reorder, drop), inject failures (timeout after write, 5xx, 429), move manual
  clock. Messy cases deterministic, no test sleep.
- Fake QBO may only do what sandbox seen to do. One contract suite run against both →
  fake can't drift.
- ★ scenarios written once, run against fake + real sandbox.

## 6. Design sync, then data

Decided one at a time, scenarios as test for each:

- **Model.** Neutral form per record. Three-way per-field compare against last state both
  sides agreed on. Conflicts → issues, not guesses.
- **Writes.** Idempotency key stored before every create. Version check on every update.
  Echoes detected by stored version.
- **Jobs.** Postgres queue, one job per record, leases, retries by error class.
- **Field ownership.** Sales tax belong to QBO. Payments moved before invoice voided or
  reduced.

Database schema last, from these decisions: links, jobs, issues, audit log, poll cursors
([`db/baseline.sql`](../db/baseline.sql)).

## 7. Build foundation

Tooling + check gate (format, lint, typecheck, tests) first. Then:

- decimal money helpers
- fresh database per test
- two fakes, each with failure injection
- QBO contract suite, run against fake + sandbox

## 8. Build sync, one capability at a time

Each step own scenario tests + review before next:

1. repositories
2. neutral form + diff
3. mappers
4. webhook intake
5. worker
6. reconcile engine
7. creating + matching invoices
8. edits + conflicts
9. tax
10. payments
11. voids + deletes
12. polling
13. failure handling

Reviews + tests found real problems on way, fixed:

- **Create with lost response could duplicate.** Fix: store fields being created on link,
  adopt own create if it arrive early.
- **CDC cursor followed future-dated sandbox record, froze.** Fix: cursor = time of request.
- **Job with expired lease could overwrite result of job that took over.** Fix: job outcomes
  fenced by attempt.

## 9. Prove it on real QBO sandbox

★ scenarios moved into one suite running against fake + real sandbox. In sandbox, QBO
changes picked up only by CDC polling, as in production without public webhook URL.

Sandbox company shared, can't reset → each run unique name prefix, delete or deactivate
everything it create.

General ledger postings (G2) checked in QBO General Ledger report.

## 10. Make it runnable service, give operators control

- `pnpm dev` run service with HTTP client for invoicing API; secrets kept out of logs.
- Operator resolve conflict by picking side; sync then write that side through normal path.
- Operator retry failed job.
- `pnpm sync:reconcile` handle records existing before sync connected.

## 11. Cover remaining scenarios, add invariants

All `extra` scenarios got tests. Property-based tests (fast-check) generate random edits on
both sides, lossy delivery, injected failures, then check three things:

- every pair converge or flagged
- no duplicates
- replaying every notification write nothing

Found real bug: payment allocated to invoice voided on other side (write-up testing
section). Fix: flag such payment as conflict, not write it.

## 12. Final review

Whole branch reviewed against design + scenarios, issues found fixed, both suites (offline +
sandbox) ran green. Remaining limits written in [`design-details.md`](design-details.md) §5,
"Known limits".
