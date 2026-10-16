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
  reliability under partial failure · test quality · written tradeoff reasoning.
- Minimum requirements: (1) mapping - internal invoices ↔ QB invoices, internal payments ↔
  QB payments, sync general ledger entries and accounts; (2) sync logic - ingest changes
  from either side, fetch current state as needed, apply safely to the other side;
  (3) idempotency - duplicates / retries never create duplicate records or repeated writes;
  (4) conflict handling - resolve or flag conflicting edits; (5) auditability - what
  changed, what action was taken, whether it succeeded; (6) failure handling - retries,
  transient failures, timeouts, partial success.
- Edge cases (address at least some): duplicate webhook delivery · out-of-order events ·
  same invoice edited in both systems · delete vs void · partially paid invoices being
  edited · timeout after write to an external system · retry after partial success ·
  existing invoices in both systems with no prior linkage record.
- Priority (email): accuracy and a realistic approach to integration mess over feature
  count; core issues (idempotency, conflicts, partial failures) first; tests for the most
  important edge cases.
- Deliverables: ZIP of source · README (setup + assumptions) · short design write-up
  (decisions + trade-offs) · short demo video against the sandbox (optional, highly
  appreciated).
- An actionable feedback round by email follows the first submission - use it to refine and
  resubmit.

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
- **Design:** not decided yet. An earlier unreviewed draft was dropped (still in git history,
  commit `920a679`, `DESIGN.md`); design comes after the test scenarios.
- **Tests first:** scenarios written as Given-When-Then (plain Vitest with Given/When/Then
  structure plus a markdown scenario list; no Cucumber / Gherkin tooling).
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

1. [ ] Test scenario list (Given-When-Then, markdown) for the cases in `TASK.md` - review.
2. [ ] Intuit developer account + sandbox app; OAuth helper script; verify the QBO list
       above and record the findings.
3. [ ] Design (driven by the scenarios and the QBO findings) - review.
4. [ ] Implementation + tests (fake QBO client for deterministic tests, e2e against the
       sandbox).
5. [ ] README, design write-up (decisions + trade-offs), demo video, ZIP.
