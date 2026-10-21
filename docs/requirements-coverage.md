# Requirements coverage

Each point of [`assignment.md`](assignment.md): how it is met, where in the code, which tests
prove it. The reasoning is in [`design-writeup.md`](design-writeup.md). Test ids are from
[`test/SCENARIOS.md`](../test/SCENARIOS.md); ★ = also run against the real QBO sandbox
(`pnpm test:sandbox`). Scenario tests are in `test/scenarios/`, one file per group.

## Should handle

| Item | How | Tests |
|---|---|---|
| Invoice creation | Look for a counterpart, else create under a stored idempotency key; a missing customer, item or account is linked or created first | C1★ C2★ C3 C4 C5 C6★ |
| Invoice updates | Per-field three-way diff; version-checked writes | U1★ U2★ U3 U4 U5 U6 U7 U8 |
| Deletions / voids | Delete ↔ delete, void ↔ void; QBO void detected by shape; re-read before a QBO delete | V1★ V2★ V3 V4 V5★ V6 V7 |
| Payment status changes | Payments synced as their own entity; balance and status derived on each side | P1★ P2★ P3–P10 |
| Duplicate events | A notification means "look at X": merged into the pending job, or nothing to do | E1★ E2 E3a, I3 |
| Conflicting edits | Different fields merge; the same field changed differently opens an issue and parks the pair | F1 F2★ F3 F4 F5 V7 |

## Minimum requirements

| Requirement | How | Code | Tests |
|---|---|---|---|
| 1. Mapping (invoices, payments, GL, accounts) | One link table for every type; a neutral form with link-id references and decimal money; Income accounts and items synced, so QBO posts each line to the mapped account | `db/baseline.sql`, `src/sync/neutral.ts`, `map-invoicing.ts`, `map-qbo.ts` | C4 G1 G2★ G3 P4 |
| 2. Sync logic | Webhooks, polling (QBO CDC, invoicing feed) and `pnpm sync:reconcile` all become an audit entry + a job; every job reads current state on both sides; payloads are never used as data | `src/sync/intake.ts`, `poll.ts`, `engine.ts`, `src/http/server.ts` | E0 E4 L5, all C / U / V / P |
| 3. Idempotency | Duplicates merge into the pending job; create keys stored before the call; adoption of our own early create; echoes found by stored versions; unique links | `src/sync/engine.ts`, `src/store/jobs.ts` | E1★ E2 U3 R1★ R2 R5, I2 I3 |
| 4. Conflict handling | Issues park the pair; they close when the sides converge or an operator picks a side (`PATCH /issues/:id`); no last-writer-wins | `src/sync/diff.ts`, `engine.ts`, `resolve.ts` | F1–F5 V6 V7 U6 U7 L2 L3 P10, I1 |
| 5. Auditability | Append-only `audit_log`: per-field `{from, to, source}`, action and job id, error; every failed attempt is an `attempt_failed` entry; read through `GET /audit` | `src/store/audit.ts`, `src/sync/worker.ts` | A1; every scenario asserts its audit trail |
| 6. Failure handling | Transient errors retried with backoff (429 after `retry-after`, 401 after a token refresh); stale versions reconciled again; permanent errors fail the job, visible at `GET /jobs?status=failed` and retried with `PATCH /jobs/:id`; leases recover a crashed worker | `src/sync/errors.ts`, `worker.ts`, `src/store/jobs.ts` | R1★ R2 R3 R3a R4 R5 R6 |

## Edge cases (all 8)

| Edge case | How | Tests |
|---|---|---|
| Duplicate webhook delivery | Merged into the pending job, or nothing to do | E1★ E2 |
| Out-of-order events | Current state is read, so order doesn't matter | E3 E3a E6 |
| Same invoice edited in both systems | Three-way diff: merge or conflict | F1 F2★ F3 |
| Delete vs void | Mirrored as-is; delete or void vs edit is a conflict; a revived void is flagged | V1–V7 |
| Editing partially paid invoices | Payments reconciled first; allocations over the new total are flagged | P8 P9 V3 |
| Timeout after write | Key and body stored before the call, plus adoption | R1★ R2 |
| Retry after partial success | Each step stores its result as it goes | R5 |
| Existing records with no link | Invoices by number + customer + total, catalogue by name, payments by customer + amount + allocations; one match links, several raise an issue | L1★ L2–L6 |

## Real QBO, not mocked

- `src/qbo/` is a real client (OAuth, refresh, `requestid`, timeouts).
- QBO behaviour was verified on the sandbox first: [`qbo-spec.md`](../qbo-playground/qbo-spec.md).
- The fake QBO does only verified behaviour, and the contract suite `test/qbo-contract/`
  runs on both the fake and the sandbox.
- The ★ scenarios run the same code on the fake and the sandbox (`test/scenarios/star.ts`).
- `pnpm demo` walks through the sync end to end on the sandbox.

Known limits: [`design-details.md`](design-details.md), "Known limits".
