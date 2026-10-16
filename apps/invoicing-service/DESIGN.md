# invoicing-service - Design

Our internal invoicing system: a generic, simple invoicing app that the sync service
treats as an independent system (API + change webhooks). Status: **draft, not reviewed** -
proposed model and open questions to settle before building.

## Proposed model

- **Customer** - id, name, email, timestamps.
- **Invoice** - id, human number (e.g. `INV-0042`), customer, issue date, due date, memo,
  status, total, balance, **version** (increments on every change), timestamps.
- **Invoice line** - description, quantity, unit price, line amount, position.
- **Payment** - invoice, amount, date, version, timestamps.
- **Change event** - entity type + id, change kind (created / updated / voided / deleted),
  version, time. Stored, then delivered as a webhook with retries.

Fixed simplifications: money as decimal (2 places, never float), single currency (USD),
no tax, no discounts, no domain-specific fields.

## Open questions (with current recommendation)

1. **Delete: hard or soft?** Recommend soft delete (tombstone), so a refetch after a
   "deleted" event returns "deleted", not "never existed".
2. **Status: stored or derived?** Recommend storing only `open` / `void`; unpaid /
   partially paid / paid derived from payments. No `draft` (QBO invoices have none).
3. **Editing invoices that have payments.** Recommend allowing edits, but rejecting a
   change that would bring the total below the amount already paid.
4. **Payment ↔ invoice cardinality.** QBO allows one payment across several invoices.
   Recommend one payment → one invoice, stated as an assumption.
5. **Editing / deleting payments.** Recommend allowing both (QBO does) - this is the
   "payment status changes" case.
6. **Webhook payload size.** Recommend thin payloads (id, kind, version); the sync always
   refetches, as the task says to expect.
7. **Concurrent updates.** Recommend optimistic locking: every update carries the version
   it was based on; a stale version is rejected. Prevents the sync from silently
   overwriting a user's edit.
8. **Retry-safe creates.** Recommend an idempotency key on create requests, so sync
   retries never create duplicates.
9. **Accounts / GL.** The task requires mapping GL entries and accounts; lines may need
   an income account. Leave open until the sync design.
10. **Fault injection.** Optional switch to deliver webhooks duplicated, delayed or out of
    order - makes edge cases reproducible in tests and visible in the demo.

Items 7 and 8 shape the code most: they are the invoicing side of idempotency and
conflict handling.
