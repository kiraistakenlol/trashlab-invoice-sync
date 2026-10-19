# Design write-up

The key decisions and what each one costs. Full rules and known limits:
[`design-details.md`](design-details.md). A bare § refers to a section of
[`qbo-playground/qbo-spec.md`](../qbo-playground/qbo-spec.md), QBO behaviour verified on the
sandbox.

## Summary

**How it was approached.** Before any design, a small real QBO client was used to call every
API that matters for a sync, and the places where QBO behaves differently from its docs
were written down in [`qbo-spec.md`](../qbo-playground/qbo-spec.md). Next, every case to
handle, from the task and beyond, was listed as a scenario in
[`test/SCENARIOS.md`](../test/SCENARIOS.md). Only then was the design chosen; the schema,
the fakes, the tests and the sync came last.

**The core idea.** A webhook is only a signal: "look at record X". It becomes a job in a
Postgres queue. The worker reads the record on both sides as it is now and compares each
field with the last version both sides agreed on (the snapshot). One side changed: copy
it. Both made the same change: nothing to do. Both changed it differently: a conflict.
Duplicate, late, out-of-order and incomplete events therefore need no code of their own,
since the sync always acts on current state. The cost is that every job reads both sides:
one to three QBO calls, well under QBO's rate limit.
([core idea](#core-idea-reconcile-state-not-replay-events))

**The safety nets.**

- The idempotency key is stored before every create, so a retry after a timeout never
  makes a duplicate. ([idempotency](#idempotency-and-partial-failure))
- Every write carries the version it read, so a newer edit is never overwritten, and the
  sync's own echo finds nothing to do.
- Both systems are also polled (QBO CDC, the invoicing events feed), so a lost webhook is
  still caught. ([intake](#intake-webhooks-fast-path-polling-guarantee))
- A conflict becomes an issue: nothing is written until the sides agree or a person picks
  one. No last-writer-wins. ([conflicts](#conflicts-become-issues-never-guesses))
- Every step, and every failed attempt, is an audit entry: what changed, what the sync did,
  whether it worked. ([audit](#audit))

**QBO surprises that became rules.** A void in QBO has no flag, so it is detected by its
shape. Delete ignores the version, so the sync re-reads right before deleting. Voiding or
reducing an invoice silently unapplies its payments, so payments are moved first. The QBO
UI adds sales tax the API can't reproduce, so tax belongs to QBO and is never written back.
([QBO quirks](#qbo-quirks-designed-for-not-found-in-production))

**Proof.** Scenario tests run the real sync and Postgres against fakes with failure
controls: duplicate, reordered and lost events, timeouts after a write. The core suite also
runs against the real QBO sandbox, and one contract suite keeps the fake QBO honest.
Property-based tests generate random edits and failures; they found a real bug, a payment
on an invoice voided on the other side. ([testing](#testing-strategy))

**Limits.** A short race window on QBO delete; one instance per QBO company. Next: a
database token store, an operator UI, metrics. ([next](#next-with-more-time))

How each integration problem is handled:

| Integration problem | What handles it |
|---|---|
| Duplicate, late or reordered event | state reconcile + one pending job per record |
| Lost webhook | cursor polling |
| Incomplete payload | the record is always re-read |
| Timeout after write | idempotency key + adoption of our own create |
| Retry after partial success | each step stores its result; reconcile again |
| Edits in both systems at once | three-way diff → issue |
| Two workers race | versions + unique indexes |
| Own echo | versions stored on the link |
| Existing records with no link | [match before create](#records-with-no-link); differing fields → conflict |

## The system at a glance

```
  ┌───────────────────────────────┐                ┌───────────────────────────────┐
  │ Invoicing system (assumed)    │                │ QuickBooks Online             │
  │ API · webhooks · events feed  │                │ API · webhooks · CDC          │
  └───────────────┬───────────────┘                └───────────────┬───────────────┘
                  │ change notifications      change notifications │
                  ▼                                                ▼
  ┌────────────────────────────────────────────────────────────────────────────────┐
  │ INTAKE: everything becomes "look at record X"                                  │
  │   webhooks     POST /webhooks/invoicing, /webhooks/qbo (signature checked)     │
  │   poll loop    invoicing events feed + QBO CDC, from stored cursors            │
  │   CLI          pnpm sync:reconcile: every record on both sides, once           │
  └────────────────────────────────────────┬───────────────────────────────────────┘
                                           │ enqueue
                                           ▼
  ┌────────────────────────────────────────────────────────────────────────────────┐
  │ JOB QUEUE (Postgres)   one pending job per record · leases · retries, backoff  │
  └────────────────────────────────────────┬───────────────────────────────────────┘
                                           │ claim
                                           ▼
  ┌────────────────────────────────────────────────────────────────────────────────┐
  │ WORKER → RECONCILE ENGINE   one job = one pair of records                      │
  │   1. read the record's current state from both systems' APIs                   │
  │   2. map both to the neutral form                                              │
  │   3. diff each field 3 ways: snapshot vs invoicing vs QBO                      │
  │   4. write a one-sided change to the other system · adopt our own create ·     │
  │      park a conflict as an issue                                               │
  │   EntitySpec per type: account · item · customer · invoice · payment           │
  └────────────────────────────────────────┬───────────────────────────────────────┘
                                           │ store results
                                           ▼
  ┌────────────────────────────────────────────────────────────────────────────────┐
  │ SYNC DATABASE   links + snapshots · issues · audit log · poll cursors          │
  └────────────────────────────────────────▲───────────────────────────────────────┘
                                           │
  ┌────────────────────────────────────────┴───────────────────────────────────────┐
  │ OPERATOR API   GET /audit · /issues · /jobs · /links/:id                       │
  │                PATCH /issues/:id (pick a side) · PATCH /jobs/:id (retry)       │
  └────────────────────────────────────────────────────────────────────────────────┘
```

## Core idea: reconcile state, not replay events

A notification only says "look at record X". The job reads X now on both sides and compares
each field three ways: the snapshot (the neutral form the pair last agreed on), invoicing
now and QBO now.

| Changed in | Action |
|---|---|
| one side | copy to the other side |
| both, the same way | write nothing, refresh the snapshot |
| both, differently | conflict |
| neither | nothing (echo, duplicate, late event) |

**Why:** every delivery problem in the task becomes "look again", so none needs its own
mechanism: no dedup keys, no event ordering, no buffering. A retry after a crash sees what
was already done. Each case has a scenario test: E1–E6 delivery, U3 echo, R1–R5 retries.

**Alternative:** replay each event ("memo changed → set the memo on the other side"). That
needs dedup and ordering per case, and breaks on a lost or incomplete event.

**Cost:** every job reads both sides. Measured on the fake QBO:

| Job | QBO requests |
|---|---|
| notification with nothing to do (duplicate, echo, late) | 1 GET |
| invoicing edit copied to QBO | 3 (GET, GET before write, POST) |
| payment created in QBO | 3 (GET of the allocated invoice, POST, GET) |

QBO allows 500 requests/min and 10/s per company (§12.1); the sandbox took bursts of 12
parallel requests and answered 15 with 429. One company therefore handles roughly 150–500
jobs/min. The worker runs 2 jobs at once by default (`WORKER_CONCURRENCY`), well under the
per-second limit; a 429 is retried after `retry-after`.

## Intake: webhooks fast path, polling guarantee

Both systems send webhooks; QBO's are signed and carry ids only. Both are also polled from
stored cursors (QBO CDC, the invoicing events feed), and `pnpm sync:reconcile` queues every
record once, for records older than the sync. Every source does the same thing: an audit
entry and a job, in one transaction.

The QBO cursor:

- is the time of the request, never a record timestamp. One sandbox account has a
  `LastUpdatedTime` a month in the future and shows up in every CDC window (§11.5); a
  cursor taken from record timestamps would freeze there.
- steps back 5 s on each read (`cdcStepBackMs`), covering clock skew, whole-second
  timestamp filters (§4) and the exclusive `changedSince` (§10). Records seen twice are
  harmless.

## Neutral form, links, one generic engine

Both sides map to one neutral form: references are link ids (a customer is "link 17", not
`cus_42` or QBO `7`), money is a decimal string, and an invoice's lines are one field.

The link table holds pairs of every type: invoicing id, QBO id, snapshot and the version on
each side. A unique index per side means a record can't be linked twice and two jobs can't
create two counterparts.

One reconcile engine serves every entity type. An `EntitySpec` per type says how to read,
match, create, update and remove, plus extra rules (tax, void, payments first).

**Cost of lines as one field:** edits to *different* lines on both sides are a conflict.
Per-line merging needs a line id stable on both sides, and QBO's are not: a line sent
without an id gets a new one and ids are never reused (§6.3). Since the sync rewrites all
lines on every write, the ids change every time.

## Idempotency and partial failure

- **Creates.** A link row with an idempotency key is written before the create. Every
  retry, from any job, reuses the key: `requestid` in QBO, `Idempotency-Key` in invoicing.
  On the sandbox, five concurrent creates with one `requestid` made one record (one 200,
  four 425), and a replay returns the first response (§7). The link also stores the fields
  being created, so a retry resends the same body. This matters most for payments: two
  identical payments are legitimate, so a payment can't be matched by content afterwards.
- **Adoption.** If the notification for a new record arrives before the link stores its
  id, the record is recognised as our own create and adopted, not copied back.
- **Updates** send the `SyncToken` or `version` they read; if stale, the job re-reads and
  compares again.
- **Partial success** needs no step tracking: each step stores its result (a link) as it
  goes, and a retry reconciles again, skipping what is done.

## Job queue in Postgres

- One pending job per record; notifications merge into it.
- Claimed with `FOR UPDATE SKIP LOCKED`: other workers skip to the next job without
  waiting. The lock is held for the claim only, never across API calls.
- A running job holds a time-limited lease; its outcome is stored only by the claim that
  ran it.
- Errors are classified: transient (retry with backoff and jitter), stale (reconcile
  again), permanent (failed, visible).
- Correctness rests on version checks, not the lease: a stalled worker can outlive it.

## Conflicts become issues, never guesses

A conflict parks the pair: nothing is written either way. The issue closes itself when both
sides become equal, or an operator picks a side (`PATCH /issues/:id`) and the winner is
written through the normal path.

The same mechanism covers everything the sync won't decide alone: unsupported QBO data, a
changed invoice number, a number used more than once, taxed lines edited in invoicing, a
void revived in QBO, a payment allocated to an invoice voided on the other side.

**Why not last-writer-wins:** it depends on the clocks of two systems and silently drops an
edit. A fixed winning side is a business decision, not the sync's. In accounting data a
silently lost edit is worse than asking a person.

## Records with no link

Before creating anything, the sync looks for a counterpart:

- invoices by number (case-insensitive) + customer + total; customers, items and accounts
  by name;
- payments, which share no key, by customer + amount + allocations among unlinked
  payments. A second identical payment made later is created, not flagged.

Exactly one match is linked and nothing is created. Several candidates, a number held by a
different invoice, or twin numbers (`DocNumber` is not unique, §5.2) raise an issue. Fields
that differ at the first link have no common past, so they are a conflict, not a guess.

Records that existed before the sync was connected: `pnpm sync:reconcile`. Tests L1–L6.

## Audit

`audit_log` is append-only: one entry per notification received and per step taken
(linked, created, updated, voided, deleted, no change, issue opened or resolved), and one
per failed job attempt (`attempt_failed`).

- **What changed:** per field `{from, to, source}`.
- **What was done:** the action and the job id.
- **Did it succeed:** the error is empty.

Read through `GET /audit` per record; a pair's history is that of its two records. Logs are
separate and are not the audit. Test A1; every scenario also asserts its audit trail.

## QBO quirks designed for, not found in production

Before any sync code, QBO behaviour was explored and verified on the sandbox
([`qbo-spec.md`](../qbo-playground/qbo-spec.md)), and the sync was built around it:

- A void has no flag: it zeroes the invoice and adds a `"Voided - "` note, which any later
  update can overwrite (§8.1).
- Delete ignores `SyncToken` (§8.2).
- Voiding, deleting or reducing an invoice silently unapplies its payments (§8.1, §8.4).
- Invoices saved in the QBO UI carry sales tax the API won't compute; once a tax code is
  present, line edits without it are rejected with `6000` (§5.2, §15).
- `DocNumber` is not unique (§5.2, §13.1).
- A deactivated customer, account or item is renamed "(deleted)"; the name is freed, but a
  create under it can fail with `6240` for a short time (§5.1).

Two of these became rules:

- **Tax belongs to QBO:** imported as an amount, never written back.
- **Payments first:** invoicing changes one record per operation, so payments are
  reconciled before an invoice is voided, deleted or reduced, mirroring what QBO does
  implicitly.

## General ledger: sync the source documents, not the postings

GL entries in both systems are a consequence of invoices and payments. The sync carries the
documents and the account mapping and QBO posts them, so the GL is right by construction;
this is checked on the sandbox (G2 reads QBO's General Ledger report).

| Invoicing | QBO | Posting in QBO | Synced |
|---|---|---|---|
| account (income) | `Account`, type Income | revenue, credit | linked by name, both ways (G1) |
| item → its income account | `Item.IncomeAccountRef` | each line posts to its item's account | both ways |
| invoice total | invoice | A/R, debit | both ways |
| payment | payment | A/R credit, Undeposited Funds debit | both ways |
| tax (amount) | sales tax on the invoice | sales tax payable | from QBO only, as an amount |

- **Why not sync journal entries:** postings are already derived from the documents on both
  sides; writing them too would post twice, and the invoicing contract has no ledger.
- **Accounts:** only Income accounts are synced. A/R, Undeposited Funds, bank and expense
  accounts belong to QBO and change with every posting; the sync ignores them.
- **Manual journal entries in QBO** have no counterpart in invoicing: acknowledged and
  skipped (G3).
- **Cost:** payments always land on Undeposited Funds; depositing to a bank is a QBO action
  outside the sync. An invoicing system with its own ledger would need JE ↔ JE sync: account
  links, `requestid` on create, a customer on every A/R line (§11.4).

## Testing strategy

The integration mess has to be reproducible. Most tests run the real sync and a real
Postgres against two in-memory fakes; the invoicing one is `invoicing-sim/`, the same code
`pnpm invoicing:dev` serves over HTTP. Each test decides when notifications arrive
(duplicated, reordered, dropped), which call fails (timeout after write, 5xx, 429) and what
time it is. Nothing sleeps. Every case in [`test/SCENARIOS.md`](../test/SCENARIOS.md) is a
deterministic test.

A fake is only worth its likeness to the real thing. The fake QBO does only what the
sandbox was seen to do, and one contract suite runs against both so they can't drift. The
★ scenarios are written once and also run against the real sandbox.

Hand-written scenarios only cover cases someone thought of. Property-based tests generate
random edits on both sides, lossy delivery and failures, then check that pairs converge or
are flagged, nothing is duplicated, and a replay writes nothing. They found a real bug: a
payment allocated to an invoice voided on the other side before either synced. Depending on
direction, the allocation was silently dropped, the job failed forever with no issue, or a
timeout made a duplicate payment. The fix is the flagging rule in the conflicts section;
the shrunk counterexamples are now named tests (P10).

## Next, with more time

Known limits: [`design-details.md`](design-details.md), "Known limits". With more time:

- a database token store, for several instances
- separate issue kinds for "blocked until the data is fixed", instead of a flag on `conflict`
- per-line merge of invoice lines, if edits to lines on both sides are common
- an operator UI over the issues and audit API
- metrics: queue depth, retry rates, open issues
