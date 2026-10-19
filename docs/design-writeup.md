# Design write-up

This covers the decisions that shape the sync and what each one costs. The full design,
with every rule and limit, is in [`DESIGN.md`](DESIGN.md).

## The core idea: reconcile state, don't replay events

A notification from either side only means "look at record X". A job reads X's current
state on both sides and compares each field three ways:

- **the snapshot:** the neutral form the pair last agreed on;
- **invoicing now;**
- **QBO now.**

What happens then:

| Changed in | Action |
|---|---|
| one side | copy it to the other side |
| both sides, the same way | nothing to write; refresh the snapshot |
| both sides, differently | conflict |
| neither | nothing (an echo, a duplicate, a late event) |

**Why:** the problems the task lists all reduce to "look again":

- duplicated, delayed and out-of-order notifications;
- incomplete payloads;
- lost webhooks;
- the sync's own echoes;
- retries after partial success.

None of them needs its own mechanism, so there are no dedup keys, no event ordering and
no buffering. A retry after a crash sees what has already been done. Each of these cases
has its own scenario test: E1-E6 for delivery, U3 for the echo, R1-R5 for retries.

**Alternative:** replay each event ("memo changed → set memo on the other side"). That
needs dedup and ordering per case, and it breaks on a lost or incomplete event.

**Cost:** every job reads both sides. Measured against the fake QBO:

| Job | QBO requests |
|---|---|
| a notification with nothing to do (duplicate, echo, late event) | 1 GET |
| an invoicing edit copied to QBO | 3 (GET, GET before the write, POST) |
| a payment created in QBO | 3 (GET of the allocated invoice, POST, GET) |

QBO allows 500 requests per minute and 10 per second per company. That is
[`qbo-spec.md`](qbo-playground/qbo-spec.md) §12.1: bursts of up to 12 parallel requests
succeeded in the sandbox, and 15 got 429s. So one company can absorb roughly 150-500
jobs a minute. The worker runs 2 jobs at a time by default (`WORKER_CONCURRENCY`), which
stays well under the per-second limit, and a 429 is retried after its `retry-after`.

## A neutral form and one generic engine

Both sides map to one neutral form:

- references point at link ids, so a customer is "link 17", not `cus_42` or QBO `7`;
- money is a decimal string;
- an invoice's lines are one field.

One reconcile engine handles every entity type. An `EntitySpec` per type holds what is
specific to it: how to read, match, create, update and remove it, and its extra rules
(tax, void, payments first).

**Cost of lines as one field:** edits to *different* lines on both sides become a
conflict. Merging per line would need a stable id per line on both sides. QBO line ids
don't give one: a line sent without its id gets a new one, and ids are never reused
(§6.3). The sync rewrites all lines on every write, so the ids change each time.

## Conflicts become issues, never guesses

A conflict parks the pair: nothing is written either way. The issue closes by itself when
both sides become equal, or an operator picks a side (`PATCH /issues/:id`), which is then
written through the normal path.

The same mechanism covers everything else the sync won't decide alone:

- unsupported QBO data;
- a changed invoice number;
- a number used more than once;
- taxed lines edited in invoicing;
- a void revived in QBO;
- a payment allocated to an invoice the other side has voided.

**Why not last-writer-wins:** it depends on the clocks of two systems and silently drops
an edit. A fixed winning side is a business decision, not a sync decision. For accounting
data, losing an edit silently is worse than asking a person.

## Idempotency and partial failure

The write rules:

- **Creates.** A link row with a stored idempotency key is written before the create. Every
  retry, in any job, reuses that key: `requestid` in QBO, `Idempotency-Key` in invoicing.
  In the sandbox, five concurrent creates with one `requestid` produced one record (one
  200, four 425s), and a replay returns the first response (§7). So a timeout after a
  write can't create a duplicate. This matters most for payments: two identical payments
  are legitimate, so a payment can't be matched by its content afterwards. The link also stores the fields being created, so a retry
  resends the same body.
- **Adoption.** If a notification for the new record arrives before the link has stored its
  id, that record is recognised as our own create and adopted rather than copied back.
- **Updates.** Each update sends the `SyncToken` or `version` it read. A stale one means
  re-read and compare again; a newer edit is never overwritten.
- **Partial success.** No step tracking is needed. Each step stores its result (a link) as
  it goes, and the retry reconciles again and skips what is done.

The job queue lives in Postgres:

- One pending job per record. Notifications merge into it.
- A running job holds a time-limited lease. A job's outcome is stored only by the claim
  that ran it.
- Errors are classified as transient (retried with backoff and jitter), stale (reconcile
  again) or permanent (failed and visible).
- Correctness rests on version checks, not on the lease, because a stalled worker can
  outlive its lease.

## Intake: webhooks are the fast path, polling is the guarantee

Both sides send webhooks: QBO's are signed and carry ids only. Both are also polled from
stored cursors (QBO CDC, the invoicing events feed).

The QBO cursor:

- It is the time of the request, never a record's timestamp. One pre-existing sandbox
  account has a `LastUpdatedTime` of 2026-11-19, a month in the future, so it appears in
  every CDC window (§11.5). A cursor taken from record timestamps would freeze there.
- Each read steps back 5 s (`cdcStepBackMs`). This covers clock skew, timestamp filters
  that work at whole seconds (§4) and a `changedSince` that is exclusive (§10). Records
  seen twice are harmless.

## QBO's quirks are designed for, not discovered in production

Before any sync code was written, QBO's behaviour was explored and verified against the
sandbox, and recorded in [`qbo-playground/qbo-spec.md`](qbo-playground/qbo-spec.md). The
sync is built around what that turned up:

- There is no void flag: a void is a zeroed invoice with a `"Voided - "` note, which any
  later update can overwrite (§8.1).
- Deleting ignores `SyncToken` (§8.2).
- Voiding, deleting or reducing an invoice silently unapplies its payments (§8.1, §8.4).
- An invoice saved in the QBO UI carries sales tax that the API wouldn't compute, and
  once it has a tax code, line edits without that code are rejected with `6000` (§5.2,
  §15).
- `DocNumber` isn't unique (§5.2, §13.1).
- Deactivating a customer, account or item renames it "(deleted)". The original name is
  freed, but creating under it can fail with `6240` for a short time after (§5.1).

**Two of these became rules:**

- **Tax belongs to QBO.** It is imported as an amount and never written back.
- **Payments come first.** Invoicing changes one record per operation, so payments are
  reconciled before an invoice is voided, deleted or reduced, mirroring what QBO does
  implicitly.

## Testing strategy

Tests are driven by a list of scenarios ([`test/SCENARIOS.md`](test/SCENARIOS.md)).

- **Fakes.** Most tests run the real sync and Postgres against two in-memory fakes. Each
  test controls delivery (duplicate, reorder, drop), failures (timeout after a write, 5xx,
  429) and a manual clock, so the messy cases are deterministic and fast.
- **A contract keeps the fake honest.** The fake QBO reproduces only sandbox-verified
  behaviour, and one QBO contract suite runs against both the fake and the sandbox.
- **The ★ scenarios run in both worlds.** The same tests run against the real sandbox, and
  there QBO changes are picked up only by CDC polling. The General Ledger postings are
  checked there too.
- **Property-based invariants.** Random edits on both sides, lossy delivery and injected
  failures; afterwards the pairs converge or are flagged, there are no duplicates, and
  replaying every notification writes nothing. Each property runs 50 generated cases.
  They found a real bug: a payment allocated to an invoice that was voided on the other
  side before either synced. Depending on the direction, the allocation was silently
  dropped, the job failed for good with no issue, or a timeout produced a duplicate
  payment. The fix was the flagging rule above. The shrunk counterexamples are now named
  tests (P10).

In numbers: the offline suite has 440 tests, and the sandbox project has 52 (the ★
suite, G2, the QBO contract and the sandbox-world checks).

## Known limits and what I'd do next

The limits are listed in [`DESIGN.md`](DESIGN.md) §5, "Known limits". The main ones:

- QBO's delete ignores `SyncToken`, so an edit can land in the gap between the re-read and
  the delete.
- A record created in QBO in a form that doesn't read back exactly as sent can't be
  adopted.
- More than 1000 changes of one entity inside the CDC step-back window leave newer changes
  to webhooks alone.
- One process, with tokens in a file.

**With more time:**

- a database token store, for several instances;
- separate issue kinds for "blocked until the data is fixed", instead of a flag on
  `conflict`;
- per-line merging of invoice lines, if line edits on both sides turn out to be common;
- an operator UI over the issues and audit API;
- metrics on queue depth, retry rates and open issues.
