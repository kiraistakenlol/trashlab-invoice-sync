# Take-Home Exercise: Two-Way Invoice Sync

Original task text, copied verbatim from
https://trashlab.notion.site/Take-Home-Exercise-Two-Way-Invoice-Sync-33ddb96ac1e780ed9352d6250885c0b4
(retrieved 2026-10-16).

---

Build a service that syncs invoices between an internal invoicing system and QuickBooks.

You should setup a QBO dev account for this so you can test sync for real.

Your solution should handle:

- invoice creation
- invoice updates
- invoice deletions / voids
- payment status changes
- duplicate events
- conflicting edits made in both systems

## Context

Assume:

- both systems expose APIs
- both systems emit webhook-like change notifications
- events may be duplicated, delayed, or arrive out of order
- webhook payloads may be incomplete, so you may need to refetch the full invoice
- external API calls can fail or time out
- users can make manual edits in both systems

You should use the QBO dev sandbox for this, it needs to actually use Quickbooks APIs.

## What We’re Looking For

We want to evaluate:

- systems design
- data modeling
- idempotency
- conflict resolution
- reliability under partial failure
- test quality

---

## Expectations and deliverables (from the assignment email, 2026-10-15)

- Create a QuickBooks Online (QBO) developer account and use its sandbox. The sync must
  actually work against the QBO APIs, not be mocked.
- Priority: **accuracy, technical expertise, and a realistic approach to the "mess" of
  integrating real systems** over the number of features. Not everything needs to be
  covered - resolve the core issues (idempotency, conflict management, partial failures)
  before adding extra features.
- What is implemented must be accurate and of good technical quality, with tests for the
  most important edge cases.

Delivery, in addition to a ZIP of the source code:

- **README** with setup instructions and the assumptions made.
- Short **design write-up** explaining technical decisions and trade-offs.
- Short **demo video** of the end-to-end sync working against the QBO sandbox (no hosted
  URL required). Not mandatory, but highly appreciated.

Actionable feedback will follow by email from the engineering team, to be used to refine
the submission into the final version.
