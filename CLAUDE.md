# CLAUDE.md

Take-home exercise: **Two-Way Invoice Sync** (internal invoicing system ↔ QuickBooks Online).
This file holds everything needed to continue the work in a fresh session.

⚠ This repo is submitted to the company as a ZIP. Keep it professional: no recruiting,
salary or personal notes here. Hiring context lives in the private knowledge base
(`~/Workspace/eu/career/applications/trashlab.md`, `dualentry.md`).

## The brief

**Source of truth: `TASK.md`** - the Notion task page (verbatim) plus the expectations and
deliverables from the assignment email. Anything not in `TASK.md` is our own choice, not a
requirement.

Condensed:
- Sync invoices between an internal invoicing system and QuickBooks Online (QBO), against
  the **real QBO sandbox APIs** (no mocking the sync).
- Handle: creation · updates · deletions / voids · payment status changes · duplicate
  events · conflicting edits made in both systems.
- Assume: both sides have APIs and webhook-like notifications · events duplicated, delayed,
  out of order · payloads incomplete (refetch) · API calls fail / time out · manual edits
  on both sides.
- Evaluated on: systems design · data modeling · idempotency · conflict resolution ·
  reliability under partial failure · test quality.
- Priority (email): accuracy and a realistic approach to integration mess over feature
  count; core issues (idempotency, conflicts, partial failures) first; tests for the most
  important edge cases.
- Deliverables: ZIP of source · README (setup + assumptions) · short design write-up
  (decisions + trade-offs) · short demo video against the sandbox (optional, highly
  appreciated).
- An actionable feedback round by email follows the first submission - use it to refine and
  resubmit.

Out of scope (not in the task): syncing general ledger entries and accounts - mention as a
possible next step in the write-up only.

## Submission

- **ZIP** of the source (keep `.git` for history; **no secrets**, only `.env.example`)
  uploaded at https://you.ashbyhq.com/Silver/assignment/eb8182bc-4455-462e-a476-ebd882132d5f
  ("Upload File(s)" + "Notes" field: 2-3 lines + video link).
- Backup / working remote: private GitHub repo `kiraistakenlol/trashlab-invoice-sync`.
- Deadline: none given; must be in before the next interview stage - treat as **days, not
  weeks**.

## Decisions so far

- **Stack:** TypeScript, Node, Fastify, Kysely, PostgreSQL, Vitest, Docker Compose (the
  company's stack is TS / React / Node / SQL).
- **Architecture and policies:** see `DESIGN.md` (draft v0). Key idea: webhooks are hints,
  state is truth - every event enqueues a reconcile that refetches both sides and does a
  three-way merge against the last agreed snapshot.
- Quality over breadth: core cases (idempotency, conflicts, partial failure) done well and
  tested before extra features.
- The company is AI-first; AI-assisted development is expected and fine.

## QuickBooks Online - to verify against the sandbox before relying on it

- Current webhook payload format (Intuit has been moving to a CloudEvents format) and
  signature header (`intuit-signature`, HMAC-SHA256 with the verifier token).
- `requestid` idempotency behavior on create/update (window, response on repeat).
- Current required `minorversion`.
- Deleting an invoice that has a linked payment (expected: rejected).
- Void behavior on a partially paid invoice.
- CDC endpoint limits (`/cdc?entities=...&changedSince=...`, ≤ 30 days).
- Rate limits / 429 handling; OAuth2 token lifetimes (access ~1 h, refresh ~100 days).

Credentials: Intuit developer account (sandbox company) → client id / secret / realm id /
tokens go to `.env` only (gitignored). Not created yet.

## Plan

1. [ ] Intuit developer account + sandbox app; OAuth helper script; verify the list above,
       record findings in `DESIGN.md`.
2. [ ] Skeleton: Docker Compose (Postgres), migrations, Fastify app, Vitest.
3. [ ] Internal invoicing system: customers, invoices, payments, versioning, outbox →
       change webhooks.
4. [ ] Sync core: inbox dedup, job queue (SKIP LOCKED), normalizer, three-way diff,
       conflict policy, links / snapshots, audit log.
5. [ ] QBO client: OAuth refresh, SyncToken, requestid, error classification, retries.
6. [ ] Delete vs void, payments / partial payments, initial linkage matching.
7. [ ] Tests for every edge case (fake QBO client for deterministic integration tests) +
       e2e script against the sandbox.
8. [ ] README, final DESIGN.md write-up (tradeoffs, next steps), demo video, ZIP.
