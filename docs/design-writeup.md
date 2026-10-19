# Design write-up

Big decisions + what each cost. Full rules, limits: [`design-details.md`](design-details.md).

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

Four things start work. All do same: queue job "look at record X".
- Webhook from invoicing.
- Webhook from QBO.
- Poll loop: invoicing events feed + QBO CDC, from stored cursors.
- `pnpm sync:reconcile`: records that existed before sync.

Worker take job from Postgres queue, run reconcile engine. Engine read both sides, write
what changed, store result: links + snapshots, issues, audit log. Operator read state, act
on it, via HTTP API.

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

**Why:** all task problems = "look again":

- duplicated, delayed, out-of-order notifications
- incomplete payloads
- lost webhooks
- sync's own echoes
- retries after partial success

None need own mechanism. No dedup keys, no event ordering, no buffering. Retry after
crash see what already done. Each case own scenario test: E1-E6 delivery, U3 echo, R1-R5
retries.

**Alternative:** replay each event ("memo changed → set memo other side"). Need dedup +
ordering per case. Break on lost or incomplete event.

**Cost:** every job read both sides. Measured on fake QBO:

| Job | QBO requests |
|---|---|
| notification, nothing to do (duplicate, echo, late) | 1 GET |
| invoicing edit copied to QBO | 3 (GET, GET before write, POST) |
| payment created in QBO | 3 (GET of allocated invoice, POST, GET) |

QBO limit: 500 req/min, 10 req/s per company ([`qbo-spec.md`](../qbo-playground/qbo-spec.md) §12.1). Sandbox: bursts of 12
parallel ok, 15 got 429. So one company ≈ 150-500 jobs/min. Worker run 2 jobs at once by
default (`WORKER_CONCURRENCY`), well under per-second limit. 429 retried after
`retry-after`.

## Neutral form, one generic engine

Both sides map to one neutral form:

- references = link ids. Customer is "link 17", not `cus_42` or QBO `7`
- money = decimal string
- invoice lines = one field

One reconcile engine for every entity type. `EntitySpec` per type hold specifics: how to
read, match, create, update, remove; extra rules (tax, void, payments first).

**Cost of lines as one field:** edits to *different* lines on both sides = conflict.
Per-line merge need stable line id on both sides. QBO line ids no good: line sent without
id get new id, ids never reused (§6.3). Sync rewrite all lines every write → ids change
every time.

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

Job queue in Postgres:

- One pending job per record. Notifications merge into it.
- Running job hold time-limited lease. Outcome stored only by claim that ran it.
- Errors classified: transient (retry, backoff + jitter), stale (reconcile again),
  permanent (failed, visible).
- Correctness rest on version checks, not lease. Stalled worker can outlive lease.

## Intake: webhooks fast path, polling guarantee

Both sides send webhooks. QBO's signed, carry ids only. Both also polled from stored
cursors (QBO CDC, invoicing events feed).

QBO cursor:

- = time of request, never record timestamp. One sandbox account has `LastUpdatedTime`
  2026-11-19, month in future → show in every CDC window (§11.5). Cursor from record
  timestamps freeze there.
- Each read step back 5 s (`cdcStepBackMs`). Cover clock skew, whole-second timestamp
  filters (§4), exclusive `changedSince` (§10). Records seen twice harmless.

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
flagging rule above. Shrunk counterexamples now named tests (P10).

## Next, with more time

Known limits: [`design-details.md`](design-details.md) §5. More time:

- database token store, for several instances
- separate issue kinds for "blocked until data fixed", not flag on `conflict`
- per-line merge of invoice lines, if both-side line edits common
- operator UI over issues + audit API
- metrics: queue depth, retry rates, open issues
