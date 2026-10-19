# How the work went

The order the work was done in, and why each step came where it did. What was decided:
[`design-writeup.md`](design-writeup.md); dated decisions: [`decision-log.md`](decision-log.md).
The git history follows the same steps.

## 1. Pin down the task

The task page and the assignment email were copied word for word into
[`assignment.md`](assignment.md), the one reference for every later decision. The email set
the priority: correct handling of real integration mess over the number of features.

## 2. Learn how QBO really behaves before designing anything

A sync is only as correct as its picture of the other system, and QBO's docs leave out much
that matters for a sync. So the first code was a small QBO client (OAuth, token refresh, raw
requests) and scripts running experiments against the sandbox, covering errors and the query
language, entity shapes, updates and `SyncToken`, `requestid`, void and delete, payments,
CDC, webhooks, accounts and the GL, limits and tokens, finding records, and edits made in
the QBO web UI.

The results are in [`qbo-spec.md`](../qbo-playground/qbo-spec.md): facts only, each with the
request that proved it. What they mean for the sync went into a separate file,
`qbo-playground/sync-notes.md`. Several later decisions come straight from this step (the
write-up's "QBO quirks" section).

## 3. Decide what to build, and what not

The first plan was three apps (invoicing service, sync, UI). After the QBO work it was cut to
one:

- **The invoicing system is assumed, not built.** The task says it exists, and building it
  is time outside what is evaluated. Its contract is written down
  ([`invoicing-api-contract.md`](invoicing-api-contract.md)), close to QBO's model so
  records map one to one, and an in-memory implementation plays it.
- **No UI.** Sync state is exposed through a small API.
- **One package, not a monorepo.** With one service, workspaces only add overhead.

## 4. Write the scenarios before the design

Before deciding how the sync would work, what it must handle was written as Given / When /
Then in [`test/SCENARIOS.md`](../test/SCENARIOS.md), covering every edge case of the task
and the QBO quirks from step 2. Each scenario is marked `core` (asked for directly) or
`extra`; ★ ones must also pass on the real sandbox.

The design then had to answer every scenario. That is how the central decision was reached:
reconcile current state, not replay events, because almost every case reduces to "look at
the record again".

## 5. Decide how to test it

Fixed before any sync code: the real sync and a real Postgres against two fakes, with each
test controlling delivery, failures and a manual clock; a fake QBO limited to what the
sandbox was seen to do, held to it by one contract suite run against both; ★ scenarios
written once for the fake and the sandbox.

## 6. Design the sync, then the data

Decided one at a time, with the scenarios as the test for each: the model (neutral form,
three-way compare, conflicts as issues), writes (stored idempotency keys, version checks,
echo detection), jobs (Postgres queue, leases, retries by error class) and field ownership
(tax belongs to QBO; payments move before an invoice is voided or reduced). The database
schema came last, from these decisions ([`db/baseline.sql`](../db/baseline.sql)).

## 7. Build the foundation

Tooling and the check gate (format, lint, typecheck, tests) first; then decimal money
helpers, a fresh database per test, the two fakes with failure injection, and the QBO
contract suite.

## 8. Build the sync, one capability at a time

Repositories, neutral form and diff, mappers, webhook intake, worker, reconcile engine,
creating and matching invoices, edits and conflicts, tax, payments, voids and deletes,
polling, failure handling. Each step had its own scenario tests and a review before the
next. Reviews and tests found real problems on the way:

- **A create whose response was lost could duplicate.** Fix: store the fields being created
  on the link and adopt our own create when it arrives early.
- **The CDC cursor followed a future-dated sandbox record and froze.** Fix: the cursor is
  the request time.
- **A job with an expired lease could overwrite the result of the job that took over.**
  Fix: job outcomes are fenced by attempt.

## 9. Prove it on the real QBO sandbox

The ★ scenarios became one suite running against the fake and the sandbox. On the sandbox
QBO changes are picked up only by CDC polling, as in production without a public webhook
URL. The shared sandbox can't be reset, so each run uses a unique name prefix and deletes or
deactivates everything it creates. The GL postings (G2) are checked in QBO's General Ledger
report.

## 10. Make it a runnable service with operator control

`pnpm dev` runs the service against the invoicing HTTP API, with secrets kept out of the
logs. Operators can resolve a conflict by picking a side and retry a failed job;
`pnpm sync:reconcile` handles records that existed before the sync was connected.

## 11. Cover the remaining scenarios, add invariants

All `extra` scenarios got tests. Property-based tests (fast-check) generate random edits on
both sides, lossy delivery and injected failures, then check that every pair converges or
is flagged, nothing is duplicated, and replaying every notification writes nothing. They
found a real bug (see the write-up's testing section).

## 12. Review as the reader

The whole repo was reviewed from the point of view of the person evaluating it, and the
findings fixed:

- payments recorded on both sides are matched (L6) instead of created twice;
- a failed job attempt is its own audit entry (`attempt_failed`);
- token endpoint failures and responses that came back without a record are retried, not
  treated as permanent or as a deletion;
- the in-memory invoicing fake became `invoicing-sim/`, served over HTTP by
  `pnpm invoicing:dev`, so `pnpm demo` runs the sync end to end against the sandbox.

Both suites (offline and sandbox) run green. The remaining limits are in
[`design-details.md`](design-details.md), "Known limits".
