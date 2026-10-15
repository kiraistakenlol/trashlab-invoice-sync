# Two-Way Invoice Sync - Design (draft v0)

Status: draft for discussion. QBO API details marked **(verify)** get checked against the
sandbox before code depends on them.

## 1. Goal and scope

Keep invoices and payments consistent between an **internal invoicing system** (built here,
small) and **QuickBooks Online** (real sandbox). Correctness under real-world mess over
feature count.

In scope: customers (as a dependency), invoices (create / update / void / delete), payments
(full and partial), account mapping, conflict detection, audit log, retries.
Out of scope (written up as next steps): multi-currency, tax engines, credit memos, refunds,
multi-tenant OAuth onboarding UI.

## 2. Components

```
 Internal API (Fastify)            Sync service                         QuickBooks Online
 invoices, payments, customers     ┌────────────────────────────┐       sandbox company
 + outbox → "changed" webhooks ──▶ │ inbox (dedup)              │ ◀──── webhooks (HMAC)
                                   │ job queue (Postgres)       │ ◀──── CDC poll (safety net)
                                   │ reconciler (3-way merge)   │ ────▶ REST API (OAuth2)
                                   │ links, snapshots, audit    │
                                   └────────────────────────────┘
```

- One Postgres; separate schemas `internal` and `sync` to keep the two systems honest
  (the sync service only talks to the internal system through its API).
- TypeScript, Node, Fastify, Kysely, Vitest, Docker Compose.

## 3. Core idea: events are hints, state is truth

A webhook only says "entity X on side S may have changed". The handler stores it and
enqueues **reconcile(entity_type, link)**. The worker always **refetches current state from
both sides** and decides from state, not from the event.

That one rule handles several edge cases at once:
- **duplicate delivery** - second reconcile finds nothing to do (no-op, logged);
- **out-of-order events** - order doesn't matter, we read the latest state;
- **incomplete payloads** - we never trusted the payload;
- **missed webhooks** - a periodic QBO Change Data Capture poll enqueues the same job.

Jobs are coalesced: at most one pending reconcile per entity; a per-entity advisory lock
means two workers never sync the same invoice at once.

## 4. Data model (sync schema)

| Table | Purpose |
|---|---|
| `inbox_events` | raw inbound notification, unique `(source, event_key)` → dedup; kept for audit |
| `jobs` | queue: `reconcile` jobs, `run_at`, `attempts`, `last_error`, `status` (pending / running / done / dead) - `FOR UPDATE SKIP LOCKED` |
| `entity_links` | `entity_type`, `internal_id`, `qbo_id`, `status` (linked / pending_create / conflict / unlinked) |
| `sync_snapshots` | per link: **last state both sides agreed on** (normalized JSON + hash), internal `version`, QBO `SyncToken` |
| `outbound_ops` | a write we intend to make: `op_key` (deterministic), target, payload, status (pending / sent / confirmed / failed), QBO `requestid` |
| `conflicts` | field, internal value, QBO value, base value, resolution (auto rule / needs_review / resolved_by) |
| `audit_log` | every decision: trigger, what changed, action, request / response summary, outcome |
| `account_map` | internal revenue category → QBO Account / Item id; customer map rides on `entity_links` |

## 5. Reconcile algorithm (three-way merge)

For one linked invoice:

1. Load **base** = last agreed snapshot, **A** = internal now, **Q** = QBO now (both
   normalized to one canonical shape: customer, lines, amounts, due date, status, balance).
2. Diff field by field:
   - changed only in A → push to QBO;
   - changed only in Q → push to internal;
   - changed in both to the same value → just advance the snapshot;
   - changed in both to different values → **conflict** (section 6).
3. Write with optimistic concurrency: QBO `SyncToken`, internal `version`. Stale token →
   re-run the reconcile from step 1 (someone edited meanwhile).
4. On success, store the new agreed snapshot and an audit row.

No link yet → creation path (section 8) or initial matching (section 10).

## 6. Conflict policy

Money must never be silently overwritten. Field ownership by business meaning:

| Field group | Owner when both changed | Why |
|---|---|---|
| Lines, quantities, prices, customer | **internal** wins, QBO change recorded in `conflicts` as overridden | the operational system knows what service was delivered |
| Payments / paid status | **QBO** wins | payments are often recorded by the bookkeeper (checks, bank feed) |
| Memo, due date (non-financial) | last-writer-wins by timestamp | low risk |
| Anything that would make balance < 0 or touch a paid amount | **flag `needs_review`, apply nothing** | needs a human |

Policy lives in one table-driven function, so changing it is one line and one test.

## 7. Delete vs void

| Source action | Effect on the other side |
|---|---|
| internal **void** | QBO void (`operation=void`): amount 0, stays in history |
| internal **delete** of a never-sent draft | QBO delete only if QBO invoice has no payments; else void + flag |
| QBO **void** | internal status → void |
| QBO **delete** | internal → `void` + flag "deleted in QuickBooks" (no hard delete of money records) |

QBO rejects deleting an invoice with linked payments **(verify)** - handled as a
non-retryable error → conflict.

## 8. Idempotent writes and "timeout after write"

Before any external write:
1. insert `outbound_ops` row with a deterministic `op_key` (e.g. `create-invoice:<internal_id>`),
   status `pending`;
2. call QBO with `requestid = op_key` (QBO dedups repeated requests with the same requestid
   **(verify)**);
3. timeout / 5xx → **don't blindly create again**: retry with the same requestid, and before
   a create, look up by the marker we write on every QBO record (`DocNumber` = internal
   number, `PrivateNote` contains `sync:<internal_id>`). Found → link it, mark confirmed.

Internal API writes take an `Idempotency-Key` header the same way.

Partial success (invoice created, payment not): each step is its own `outbound_op`; the
retry skips confirmed steps and continues.

## 9. Payments and partial payments

- Internal payment → QBO `Payment` with `LinkedTxn` to the invoice; QBO `Balance` is the
  check.
- QBO payment → internal payment row, linked by QBO id.
- Editing a partially paid invoice: allowed if new total ≥ amount paid; otherwise
  `needs_review`, nothing applied.

## 10. Initial linkage (records exist on both sides, no link)

Matching job: exact `DocNumber` + customer → link; else customer + total + date window →
candidate; more than one candidate or any mismatch → `needs_review`. Never auto-create while
matching is ambiguous (that's how duplicates are born).

## 11. Failures and retries

- Classify errors: transient (timeout, 429, 5xx) → retry with exponential backoff + jitter,
  max N attempts → `dead` + alert row; permanent (validation, business rule) → conflict /
  needs_review, no retry; auth (401) → refresh OAuth token once, then retry.
- Worker crash mid-job → job lease expires, another worker picks it up; all steps are
  idempotent, so re-running is safe.

## 12. Accounts and GL

QBO posts AR and income itself when an invoice is created; we don't write journal entries
for invoices. We map internal revenue categories → QBO Items/Accounts (`account_map`,
seeded from the QBO chart of accounts) and validate the mapping before the first sync.
Manual GL entries: read-only listing + mapping check; full journal sync is a next step.

## 13. Testing

- Unit: normalizer, three-way diff, conflict policy table, error classifier.
- Integration (Postgres in Docker, fake QBO client implementing the same interface):
  duplicate webhook, out-of-order events, both-sides edit, delete vs void, partially paid
  edit, timeout after write (fake returns timeout but stores the record), retry after
  partial success, initial matching.
- Contract / e2e: the same scenarios against the real sandbox (script + video).

## Open questions

- QBO webhook format and signature details in the current API version **(verify)**.
- Webhooks need a public URL: ngrok for the demo; CDC poll covers us without it.
