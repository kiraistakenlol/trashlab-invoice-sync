# CLAUDE.md

Take-home exercise: **Two-Way Invoice Sync** (internal invoicing system ↔ QuickBooks Online).
This file holds everything needed to continue the work in a fresh session.

⚠ This repo is submitted to the company as a ZIP. Keep it professional: no recruiting,
salary or personal notes here. Hiring context lives in the private knowledge base
(`~/Workspace/eu/career/applications/trashlab.md`, `dualentry.md`).

## The brief (verbatim requirements, condensed)

Source: https://trashlab.notion.site/Take-Home-Exercise-Two-Way-Invoice-Sync-33ddb96ac1e780ed9352d6250885c0b4

Build a service that syncs invoices between an internal invoicing system and QuickBooks.
Set up a QBO developer account and **use the real QBO sandbox APIs** (no mocking the sync).

Handle: invoice creation · updates · deletions / voids · payment status changes ·
duplicate events · conflicting edits made in both systems.

Assume: both systems expose APIs · both emit webhook-like change notifications · events may
be duplicated, delayed, or out of order · webhook payloads may be incomplete (refetch) ·
external API calls can fail or time out · users edit manually in both systems.

Evaluated on: systems design · data modeling · idempotency · conflict resolution ·
reliability under partial failure · test quality · written tradeoff reasoning.

Minimum requirements:
1. **Mapping** - internal invoices ↔ QB invoices; internal payments ↔ QB payments; sync
   general ledger entries and accounts.
2. **Sync logic** - ingest changes from either side, fetch current state as needed, apply
   updates safely to the other system.
3. **Idempotency** - duplicate events or retries never create duplicate records or repeated
   writes.
4. **Conflict handling** - define how conflicting edits are resolved or flagged.
5. **Auditability** - what changed, what action was taken, whether it succeeded.
6. **Failure handling** - retries, transient API failures, timeouts, partial success.

Edge cases (address at least some): duplicate webhook delivery · out-of-order events · same
invoice edited in both systems · delete vs void differences · partially paid invoices being
edited · timeout after write to an external system · retry after partial success · existing
invoices in both systems with no prior linkage record.

Deliverables: source code · README (setup + assumptions) · short design write-up · tests for
the most important edge cases · short demo video of the sync working end-to-end against the
QBO sandbox (optional, highly valued; no hosted URL needed).

Their note: "We care more about correctness, judgment, and handling of real-world
integration messiness than about surface area."

Reviewer feedback: an actionable feedback round by email is expected after the first
submission - use it to fix and resubmit.

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
