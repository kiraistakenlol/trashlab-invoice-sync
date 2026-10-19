# Design write-up

Big decisions + what each cost. Full rules, limits: [`design-details.md`](design-details.md).
Bare § = section of [`qbo-playground/qbo-spec.md`](../qbo-playground/qbo-spec.md), QBO
behaviour verified on sandbox.

## System at glance

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
  │ OPERATOR API   GET /audit · /issues · /jobs · /links                           │
  │                PATCH /issues/:id (pick a side) · PATCH /jobs/:id (retry)       │
  └────────────────────────────────────────────────────────────────────────────────┘
```

## In 5 minutes

Ten pillars reliability stand on. Detail in sections below.

1. **Notification = "look at record X".** No event replay: every job read current state on
   both sides. Duplicates, wrong order, incomplete payloads, lost events need no own
   handling. ([core idea](#core-idea-reconcile-state-not-replay-events))
2. **Per-field three-way compare.** Each field: last agreed value (snapshot) · invoicing
   now · QBO now. One side changed → copy. Both same → nothing. Both different → conflict.
   ([core idea](#core-idea-reconcile-state-not-replay-events))
3. **Link table = the mapping.** One row per pair: invoicing id, QBO id, snapshot, both
   versions. Unique indexes → record never linked twice.
   ([neutral form, links](#neutral-form-links-one-generic-engine))
4. **Neutral form.** Both systems map to one model: references = link ids, money = decimal
   strings. One generic engine; per-type rules in `EntitySpec`.
   ([neutral form, links](#neutral-form-links-one-generic-engine))
5. **Idempotent create.** Idempotency key + fields being created stored on link *before*
   call. Every retry same key, same body → timeout after write make no duplicate. Own create
   seen before its id stored → adopted, not copied back.
   ([idempotency](#idempotency-and-partial-failure))
6. **Optimistic versions on update.** Write carry `SyncToken` / `version` it read. Stale →
   re-read, compare again. Newer edit never overwritten. Link itself updated same way.
   ([idempotency](#idempotency-and-partial-failure))
7. **Own echo die by itself.** After write, link store new versions → echo notification do
   nothing. Partial success healed by reconciling again: each step store result at once.
   ([idempotency](#idempotency-and-partial-failure))
8. **Postgres queue.** One pending job per record (duplicates merge), lease not long locks,
   errors classed transient (backoff) · stale (reconcile again) · permanent (visible to
   operator). ([job queue](#job-queue-in-postgres))
9. **Conflict = issue, never guess.** Conflicted pair parked: nothing written until sides
   converge or operator pick side. No last-writer-wins.
   ([conflicts](#conflicts-become-issues-never-guesses))
10. **Webhooks fast path, polling guarantee.** Lost webhook → change still found by cursor
    poll (QBO CDC, events feed). Cursor = request time, stepped back.
    ([intake](#intake-webhooks-fast-path-polling-guarantee))

On top:

- **Audit:** every notification + every step in `audit_log`, with field changes + error.
  ([audit](#audit))
- **Rules from real QBO:** tax owned by QBO; payments reconciled before invoice void /
  delete / reduce; void detected by shape.
  ([QBO quirks](#qbo-quirks-designed-for-not-found-in-production))
- **Tests** reproduce mess deterministically (fakes with failure controls), check fake
  against sandbox, find bugs with random scenarios. ([testing](#testing-strategy))

| Integration problem | What closes it |
|---|---|
| Duplicate / late / reordered event | state reconcile (1) + job merge (8) |
| Lost webhook | cursor polling (10) |
| Incomplete payload | always re-read record (1) |
| Timeout after write | idempotency key + adoption (5) |
| Retry after partial success | each step store result, reconcile again (7) |
| Edits in both systems at once | three-way diff (2) → issue (9) |
| Two workers race | versions + unique indexes (3, 6) |
| Own echo | versions on link (7) |
| Existing records, no link | [match before create](#records-with-no-link); differing fields → conflict |

## Core idea: reconcile state, not replay events

Notification = "look at record X". Nothing more. Job read X now on both sides, compare each
field three ways:

- **snapshot:** neutral form pair last agreed on
- **invoicing now**
- **QBO now**

| Changed in | Action |
|---|---|
| one side | copy to other side |
| both, same way | write nothing, refresh snapshot |
| both, differently | conflict |
| neither | nothing (echo, duplicate, late event) |

**Why:** every delivery problem in task (table above) = "look again". None need own
mechanism: no dedup keys, no event ordering, no buffering. Retry after crash see what
already done. Each case own scenario test: E1-E6 delivery, U3 echo, R1-R5 retries.

**Alternative:** replay each event ("memo changed → set memo other side"). Need dedup +
ordering per case. Break on lost or incomplete event.

**Cost:** every job read both sides. Measured on fake QBO:

| Job | QBO requests |
|---|---|
| notification, nothing to do (duplicate, echo, late) | 1 GET |
| invoicing edit copied to QBO | 3 (GET, GET before write, POST) |
| payment created in QBO | 3 (GET of allocated invoice, POST, GET) |

QBO limit: 500 req/min, 10 req/s per company (§12.1). Sandbox: bursts of 12 parallel ok, 15
got 429. So one company ≈ 150-500 jobs/min. Worker run 2 jobs at once by default
(`WORKER_CONCURRENCY`), well under per-second limit. 429 retried after `retry-after`.

## Intake: webhooks fast path, polling guarantee

Both sides send webhooks. QBO's signed, carry ids only. Both also polled from stored
cursors (QBO CDC, invoicing events feed). `pnpm sync:reconcile` queue every record once,
for records older than sync. Every source do same: audit entry + job, one transaction.

QBO cursor:

- = time of request, never record timestamp. One sandbox account has `LastUpdatedTime`
  2026-11-19, month in future → show in every CDC window (§11.5). Cursor from record
  timestamps freeze there.
- Each read step back 5 s (`cdcStepBackMs`). Cover clock skew, whole-second timestamp
  filters (§4), exclusive `changedSince` (§10). Records seen twice harmless.

## Neutral form, links, one generic engine

Both sides map to one neutral form:

- references = link ids. Customer is "link 17", not `cus_42` or QBO `7`
- money = decimal string
- invoice lines = one field

Link table hold pairs for every type: invoicing id, QBO id, snapshot (neutral form last
agreed), version on each side. Unique index per side → record can't be linked twice, two
jobs can't create two counterparts.

One reconcile engine for every entity type. `EntitySpec` per type hold specifics: how to
read, match, create, update, remove; extra rules (tax, void, payments first).

**Cost of lines as one field:** edits to *different* lines on both sides = conflict.
Per-line merge need stable line id on both sides. QBO line ids no good: line sent without
id get new id, ids never reused (§6.3). Sync rewrite all lines every write → ids change
every time.

## Idempotency and partial failure

Write rules:

- **Creates.** Link row with stored idempotency key written before create. Every retry, any
  job, reuse key: `requestid` in QBO, `Idempotency-Key` in invoicing. Sandbox: five
  concurrent creates, one `requestid` → one record (one 200, four 425). Replay return first
  response (§7). Timeout after write can't make duplicate. Matter most for payments: two
  identical payments legit, so can't match payment by content after. Link also store
  fields being created → retry resend same body.
- **Adoption.** Notification for new record arrive before link store its id → record
  recognised as our own create, adopted, not copied back.
- **Updates.** Each update send `SyncToken` or `version` it read. Stale → re-read, compare
  again. Newer edit never overwritten.
- **Partial success.** No step tracking. Each step store result (a link) as it go. Retry
  reconcile again, skip what done.

## Job queue in Postgres

- One pending job per record. Notifications merge into it.
- Claim with `FOR UPDATE SKIP LOCKED`: one worker per job, others skip to next, no waiting.
  Lock held for claim only, never across API calls.
- Running job hold time-limited lease. Outcome stored only by claim that ran it.
- Errors classified: transient (retry, backoff + jitter), stale (reconcile again),
  permanent (failed, visible).
- Correctness rest on version checks, not lease. Stalled worker can outlive lease.

## Conflicts become issues, never guesses

Conflict park pair: nothing written either way. Issue close itself when both sides become
equal. Or operator pick side (`PATCH /issues/:id`), winner written through normal path.

Same mechanism for everything sync won't decide alone:

- unsupported QBO data
- changed invoice number
- number used more than once
- taxed lines edited in invoicing
- void revived in QBO
- payment allocated to invoice other side voided

**Why not last-writer-wins:** depend on clocks of two systems, silently drop edit. Fixed
winning side = business decision, not sync decision. Accounting data: silent lost edit
worse than ask human.

## Records with no link

Before create, sync look for counterpart: invoice by number (case-insensitive) + customer +
total; customer, item, account by name.

- Exactly one match → link, nothing created.
- Several candidates, number held by different invoice, or twin numbers (`DocNumber` not
  unique, §5.2) → issue, nothing linked.
- Fields differing at first link: no snapshot, no common past → conflict, not guess.

Records existing before sync connected: `pnpm sync:reconcile`. Tests L1-L5.

## Audit

`audit_log`, append-only. One entry per notification received + per step taken: linked,
created, updated, voided, deleted, no change, issue opened / resolved. Failed attempt
recorded with its error.

- **What changed:** per field `{from, to, source}`.
- **What done:** action + job id.
- **Succeeded:** error empty = yes.

Read via `GET /audit` (per record; pair history = its two records). Logs separate, not
audit. Test A1; every scenario also assert audit trail.

## QBO quirks designed for, not found in production

Before sync code: QBO behaviour explored + verified on sandbox, written in
[`qbo-playground/qbo-spec.md`](../qbo-playground/qbo-spec.md). Sync built around findings:

- No void flag. Void = zeroed invoice + `"Voided - "` note. Any later update can overwrite
  (§8.1).
- Delete ignore `SyncToken` (§8.2).
- Void, delete, reduce invoice → silently unapply its payments (§8.1, §8.4).
- Invoice saved in QBO UI carry sales tax API won't compute. Once tax code present, line
  edits without code rejected `6000` (§5.2, §15).
- `DocNumber` not unique (§5.2, §13.1).
- Deactivate customer/account/item → renamed "(deleted)". Name freed, but create under it
  can fail `6240` short time after (§5.1).

**Two became rules:**

- **Tax belong to QBO.** Imported as amount, never written back.
- **Payments first.** Invoicing change one record per operation → payments reconciled
  before invoice voided, deleted, reduced. Mirror what QBO do implicitly.

## Testing strategy

Integration mess must reproduce. Most tests run real sync + real Postgres against two
in-memory fakes (invoicing one = `invoicing-sim/`, same code `pnpm invoicing:dev` serve over
HTTP for demo). Each test decide: when notifications arrive (duplicated, reordered,
dropped), which call fail (timeout after write, 5xx, 429), what time it is. Nothing sleep.
Every case in [`test/SCENARIOS.md`](../test/SCENARIOS.md) = deterministic test.

Fake worth only as much as likeness to real. Fake QBO do only what sandbox seen to do.
One contract suite run against both → can't drift. ★ scenarios written once, also run on
real sandbox.

Hand-written scenarios cover only cases someone thought of. Property-based tests generate
random edits both sides, lossy delivery, failures. Check: pairs converge or flagged,
nothing duplicated, replay write nothing. Found real bug: payment allocated to invoice
voided other side before either synced. Depending on direction: allocation silently
dropped, or job failed forever with no issue, or timeout made duplicate payment. Fix =
flagging rule in conflicts section. Shrunk counterexamples now named tests (P10).

## Next, with more time

Known limits: [`design-details.md`](design-details.md) §5. More time:

- database token store, for several instances
- separate issue kinds for "blocked until data fixed", not flag on `conflict`
- per-line merge of invoice lines, if both-side line edits common
- operator UI over issues + audit API
- metrics: queue depth, retry rates, open issues
