# How the work went

This is the order the work was done in, and why each step came where it did. For what was
decided, see [`design-writeup.md`](design-writeup.md); for the full detail, see
[`design-details.md`](design-details.md). Dated decisions are in
[`decision-log.md`](decision-log.md), and the git history follows the same steps.

## 1. Pin down the task

The task page and the assignment email went into [`assignment.md`](assignment.md) word for word, and
that file became the one reference for every later decision. The email set the priority:
correct handling of real integration mess comes before the number of features.

## 2. Learn how QBO really behaves before designing anything

A sync is only as correct as its picture of the other system, and QBO's documentation
leaves out much of what matters for a sync. So the first code was a small QBO client
(OAuth, token refresh, raw requests), plus scripts that ran experiments against the real
sandbox. Twelve areas were checked:

- errors and the query language;
- entity shapes;
- updates and `SyncToken`;
- idempotency (`requestid`);
- void and delete;
- payments and balances;
- change data capture (CDC);
- webhooks;
- accounts and the general ledger;
- limits and tokens;
- finding records;
- edits made in the QBO web UI.

The results went into [`qbo-playground/qbo-spec.md`](../qbo-playground/qbo-spec.md). It
records only facts, each with the request that proved it. What those facts mean for the
sync went into a separate file, `qbo-playground/sync-notes.md`.

Several later decisions come straight from this step:

- A void is a zeroed invoice with a note, not a flag.
- Deleting ignores `SyncToken`.
- QBO silently unapplies payments when an invoice is voided or reduced.
- Invoices saved in the UI get sales tax.
- `DocNumber` isn't unique.
- One sandbox record is dated in the future, which breaks a naive CDC cursor.

## 3. Decide what to build, and what not to

The first plan had three apps: an invoicing service, the sync, and a UI. After the QBO
work, it was cut to one:

- **The invoicing system is assumed, not built.** The task says it exists. Building it
  would have spent the time outside what is evaluated. Instead, its contract was written
  down ([`docs/invoicing-api-contract.md`](invoicing-api-contract.md)), close to QBO's model so records map one
  to one, and an in-memory fake plays it in tests.
- **No UI.** The sync's state is exposed through a small API. The demo runs real scenarios
  against the sandbox.
- **One package, not a monorepo.** There is only one service, so workspaces would only add
  overhead.

## 4. Write the scenarios before the design

Before deciding how the sync works, the list of things it must handle was written as
Given / When / Then scenarios in [`test/SCENARIOS.md`](../test/SCENARIOS.md). It covers every
edge case in the task and the QBO quirks from step 2:

- duplicates, out-of-order and lost events;
- edits on both sides;
- void against delete;
- partially paid invoices;
- a timeout after a write;
- records that exist on both sides with no link;
- tax and the general ledger.

Each scenario is marked `core` (asked for directly) or `extra`. The ★ ones also have to
pass against the real sandbox.

The design then had to answer every scenario. That is how the central decision was
reached: reconcile current state instead of replaying events. Almost every case on the
list reduces to "look at the record again", so there was no need for a separate mechanism
per case.

## 5. Decide how to test it

The test approach was fixed before any sync code:

- The real sync and a real Postgres run against two fakes. Each test controls the
  delivery of notifications (duplicate, reorder, drop), injects failures (a timeout after
  a write, 5xx, 429) and moves a manual clock. The messy cases are deterministic, and no
  test sleeps.
- The fake QBO may only do what the sandbox was seen to do. One contract suite runs
  against both, so the fake can't drift.
- The ★ scenarios are written once and run against both the fake and the real sandbox.

## 6. Design the sync, then the data

These were decided one at a time, with the scenarios as the test for each:

- **The model.** A neutral form for each record. A three-way, per-field comparison
  against the last state both sides agreed on. Conflicts become issues instead of guesses.
- **Writes.** An idempotency key is stored before every create. Version checks on every
  update. Echoes are detected by the stored version.
- **Jobs.** A Postgres queue with one job per record, leases, and retries by error class.
- **Field ownership.** Sales tax belongs to QBO. Payments are moved before an invoice is
  voided or reduced.

The database schema came last, from these decisions: links, jobs, issues, audit log and
poll cursors ([`db/baseline.sql`](../db/baseline.sql)).

## 7. Build the foundation

The tooling and the check gate (format, lint, typecheck, tests) came first. Then:

- decimal money helpers;
- a fresh database per test;
- the two fakes, each with failure injection;
- the QBO contract suite, run against both the fake and the sandbox.

## 8. Build the sync, one capability at a time

Each step had its own scenario tests and a review before the next:

1. repositories;
2. the neutral form and the diff;
3. the mappers;
4. webhook intake;
5. the worker;
6. the reconcile engine;
7. creating and matching invoices;
8. edits and conflicts;
9. tax;
10. payments;
11. voids and deletes;
12. polling;
13. failure handling.

Reviews and tests found real problems along the way, and fixed them:

- **A create whose response was lost could be duplicated.** The fix: store the fields
  being created on the link, and adopt our own create if it arrives early.
- **The CDC cursor followed a future-dated sandbox record and froze.** The fix: the cursor
  is the time of the request.
- **A job whose lease expired could overwrite the result of the job that took it over.**
  The fix: job outcomes are fenced by attempt.

## 9. Prove it on the real QBO sandbox

The ★ scenarios were moved into one suite that runs against both the fake and the real
sandbox. In the sandbox, QBO changes are picked up only by CDC polling, as they would be
in production without a public webhook URL.

The sandbox company is shared and can't be reset, so each run uses a unique name prefix
and deletes or deactivates everything it creates.

The general ledger postings (G2) were checked in QBO's General Ledger report.

## 10. Make it a runnable service and give operators control

- `pnpm dev` runs the service with an HTTP client for the invoicing API, and secrets are
  kept out of the logs.
- An operator can resolve a conflict by picking a side; the sync then writes that side
  through the normal path.
- An operator can retry a failed job.
- `pnpm sync:reconcile` handles records that existed before the sync was connected.

## 11. Cover the remaining scenarios and add invariants

All `extra` scenarios got tests. Property-based tests (fast-check) generate random edits
on both sides, with lossy delivery and injected failures, and then check three things:

- every pair converges or is flagged;
- there are no duplicates;
- replaying every notification writes nothing.

They found a real bug, a payment allocated to an invoice voided on the other side,
described in the write-up's testing section. The fix was to flag such a payment as a
conflict instead of writing it.

## 12. Final review

The whole branch was reviewed against the design and the scenarios, the issues found were
fixed, and both suites, offline and sandbox, ran green. The limits that remain are written
down in [`design-details.md`](design-details.md) §5, "Known limits".
