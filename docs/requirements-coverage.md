# Requirements coverage

Each point of [`assignment.md`](assignment.md) → how met → where in code → which test proves
it. Test ids = [`test/SCENARIOS.md`](../test/SCENARIOS.md). ★ = also run on real QBO
sandbox (`pnpm test:sandbox`). Scenario tests: `test/scenarios/`, one file per group.

## Solution should handle

| Item | How | Tests |
|---|---|---|
| Invoice creation | Unlinked record → look for counterpart → none: create on other side under stored idempotency key. Missing customer / item / account linked or created first, same job. | C1★ C2★ C3 C4 C5 C6★ |
| Invoice updates | Per-field three-way diff (snapshot · invoicing · QBO). One-side change copied. Write carry version read; stale → re-read. | U1★ U2★ U3 U4 U5 U6 U7 |
| Deletions / voids | Delete ↔ delete, void ↔ void. QBO void detected by shape (zeroed lines + "Voided" note), no flag exists. Re-read before QBO delete. | V1★ V2★ V3 V4 V5★ V6 V7 |
| Payment status changes | Payments synced as own entity (customer, date, amount, allocations). Balance + status not synced: each side derive from payments. | P1★ P2★ P3–P10 |
| Duplicate events | Notification = "look at X". Duplicate merge into pending job, or find nothing to do. | E1★ E2 E3a, invariant I3 |
| Conflicting edits | Different fields merge. Same field, different values → issue, pair parked, nothing written. | F1 F2★ F3 F4 F5 V7 |

## Minimum requirements

### 1. Mapping

- One link table for all types (account, item, customer, invoice, payment): both ids,
  snapshot, both versions. Unique per side → no double link. `db/baseline.sql`
- Neutral form both sides map to; references = link ids, money = decimal strings.
  `src/sync/neutral.ts`, `map-invoicing.ts`, `map-qbo.ts`
- GL + accounts: Income accounts synced; items carry income account → each invoice line
  post to mapped account. QBO derive postings from invoices + payments; sandbox test read
  General Ledger report and check them. Manual journal entries out of scope.
- Tests: C4 G1 G2★ G3 P4

### 2. Sync logic

- Ingest: webhooks (QBO signature checked), polling (QBO CDC, invoicing events feed),
  `pnpm sync:reconcile`. All → audit entry + job, one transaction. `src/sync/intake.ts`,
  `poll.ts`, `src/http/server.ts`
- Fetch current state: every job read record on both sides; payload never used as data.
  `src/sync/engine.ts`
- Apply safely: version-checked writes, idempotent creates, conflicts not written,
  dependencies first, payments reconciled before invoice void / delete / reduce.
  `src/sync/specs/`
- Tests: E0 E4 L5, all C / U / V / P

### 3. Idempotency

| Threat | Guard |
|---|---|
| Duplicate notification | Merge into pending job (partial unique index); done job → versions unchanged → `no_change` |
| Retry of create after timeout | Link + key stored before call; every retry same key (`requestid` / `Idempotency-Key`) + same body |
| Own create seen before id stored | Adoption: record matching exactly one pending create joins that link |
| Own write echoed back | Link store new versions → echo find nothing |
| Two jobs create same pair | Unique index on link; loser re-read, nothing to do |

Code: `src/sync/engine.ts` (`createCounterpart`, `firstSight`), `src/store/jobs.ts`.
Tests: E1★ E2 U3 R1★ R2 R5, invariants I2 (no duplicates) + I3 (replay write nothing).

### 4. Conflict handling

- Conflict = same field changed differently both sides, or delete / void vs edit.
- Never auto-resolved. Issue in `sync_issues`, pair parked, versions kept current.
- Close: by itself when sides converge; or operator `PATCH /issues/:id` pick side → written
  through normal path. Delete vs edit resolve only to delete, void vs edit only to void.
- Same mechanism for other "won't decide alone" cases: unsupported data, revived void,
  changed number, number taken, ambiguous match, taxed lines edited.
- Why not last-writer-wins: depend on two clocks, silently drop edit.
- Code: `src/sync/diff.ts`, `engine.ts`, `resolve.ts`. Tests: F1–F5 V6 V7 U6 U7 L2 L3 P10,
  invariant I1 (every pair converge or flagged).

### 5. Auditability

- `audit_log`, append-only: every notification received + every step taken.
- What changed: per field `{from, to, source}`. What done: `action` + `job_id`. Succeeded:
  `error` null, else error text. Attempts + last error on `sync_jobs`.
- Read: `GET /audit`, `/issues`, `/jobs`, `/links`.
- Tests: A1; every scenario also assert audit trail.

### 6. Failure handling

| Case | Handling |
|---|---|
| Network, timeout, 5xx, 425, 429 | Retry, exponential backoff + jitter; 429 wait `retry-after`; attempt limit |
| 401 | Token refresh (one shared), retry |
| Stale version | Reconcile again from fresh read |
| Validation error | No retry; job `failed`, visible `GET /jobs?status=failed`, retry `PATCH /jobs/:id` |
| Timeout after write | Idempotency key + same body + adoption |
| Partial success | Each step store result as it go; retry reconcile, skip done |
| Worker crash | Lease expire, other worker take job; late outcome dropped |

Code: `src/sync/errors.ts`, `worker.ts`, `src/store/jobs.ts`. Tests: R1★ R2 R3 R3a R4 R5 R6.

## Edge cases (all 8)

| Edge case | How | Tests |
|---|---|---|
| Duplicate webhook delivery | Merge into pending job / nothing to do | E1★ E2 |
| Out-of-order events | Order irrelevant: current state read; late old event change nothing | E3 E3a E6 |
| Same invoice edited both systems | Three-way diff: merge or conflict | F1 F2★ F3 |
| Delete vs void | Mirrored as-is; delete / void vs edit = conflict; revived void flagged | V1–V7 |
| Partially paid invoice edited | Payments reconciled first; allocations over new total → flagged | P8 P9 V3 |
| Timeout after write | Key stored before call + adoption | R1★ R2 |
| Retry after partial success | Step results stored as they go | R5 |
| Existing records, no link | Match: invoice by number + customer + total, others by name; one → link, more → issue; differing fields → conflict | L1★ L2–L5 |

## Real QBO, not mocked

- `src/qbo/`: real client (OAuth, refresh, `requestid`, timeouts).
- QBO behaviour verified on sandbox first: [`qbo-playground/qbo-spec.md`](../qbo-playground/qbo-spec.md).
- Fake QBO do only verified behaviour; contract suite `test/qbo-contract/` run on fake +
  sandbox → can't drift.
- ★ scenarios same code on fake + sandbox (`test/scenarios/star.ts`).
- `pnpm demo`: end-to-end walk-through on sandbox.

## Check it yourself

```bash
pnpm test           # every scenario, invariants, contract on fake (offline)
pnpm test:sandbox   # ★ scenarios + contract on real sandbox (needs pnpm qbo:auth)
pnpm demo           # walk-through (service + invoicing:dev running)
```

## Known limits

Short list; full: [`design-details.md`](design-details.md) §5 "Known limits".

- QBO delete ignore `SyncToken`: edit between re-read + delete lost.
- Tax owned by QBO, never written back. Single currency (USD).
- Lines = one field: edits to different lines both sides = conflict.
- One instance per QBO company (tokens in file).
