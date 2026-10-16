# QBO findings - notes for the sync design

<!-- last-updated: 2026-10-16 -->

Candidate design inputs that came out of the QBO exploration, for the design step. These
are options and open choices, not decisions (decisions go to `DESIGN.md`). Facts live in
`qbo-spec.md` (section numbers in brackets); anything that follows directly from a fact is
left there.

- **Tax scope [5.2].** QBO doesn't apply tax on API creates, and when it does, it computes
  the total itself. Candidate: treat invoices as tax-free (`NON`) and state it as an
  assumption. Otherwise we send tax codes and must adopt QBO's `TotalAmt`.
- **Currency [5.2].** QBO silently stores non-USD invoices as USD. Candidate: single-currency
  scope; reject other currencies on our side.
- **Shared business key [5.2, 6.1, 13].** `DocNumber` (≤ 21 chars) can carry our invoice
  number, which helps match records that exist in both systems without a link. It is the
  only searchable place for such a key (`PrivateNote` / `CustomField` aren't queryable).
  QBO doesn't enforce uniqueness and compares case-insensitively, so our side must keep
  numbers unique ignoring case. A fallback match on customer + amount + date is possible
  but ambiguous; candidates should be flagged rather than auto-linked.
- **Customer mapping [5.1].** Invoices need a `CustomerRef`, so customers need mapping too.
  `DisplayName` is not a stable key (case-insensitive collisions, renamed on deactivation),
  so the link should store the QBO `Id`.
- **Line mapping [6.3].** Either keep our-line -> QBO line `Id` links, or resend all lines
  without Ids on each update (simpler; QBO line Ids then change on every write).
- **Echo detection [6.1].** `SyncToken` moves only on real changes. If we record the token
  our own write returned, a later event carrying that same token is our echo; a higher one
  means someone else changed the record. To be confirmed against webhooks / CDC.
- **Idempotent writes [7].** A `requestid` per intended write (e.g. derived from our job id,
  ≤ 50 chars) makes a retry after a timeout safe. Because a replay returns the old
  response and ignores the body, the key must change whenever the intended write changes
  (new SyncToken, new content); reusing a key for a different write silently does nothing.
  425 means "still in flight" - retry later with the same key.
- **Not-found vs deleted [3.2, 8.2, 10].** A `610` on GET means the id doesn't exist or was
  deleted; QBO doesn't tell which. For a linked record it means deleted; CDC's
  `status: "Deleted"` stub confirms it.
- **CDC as a safety net [10].** CDC gives current state only and is fast (< 1 s), so a
  periodic CDC poll from a stored cursor can catch anything webhooks missed. The cursor
  must step back (changedSince is exclusive and timestamps are whole seconds) and the
  apply step must tolerate seeing a record again.
- **Detecting a void [8.1].** No flag on the record: options are the `Voided - ` note
  prefix, a void operation in CDC / webhooks (pending), or treating "all lines zero" as
  void. Also a voided invoice can come back to life, so "voided" is not terminal.
- **Delete is unconditional [8.2].** QBO's delete ignores SyncToken, so a delete from us can
  wipe a concurrent manual edit; a re-read right before deleting narrows but doesn't close
  that window.
- **Payment status [9.1].** Derive paid / partly paid from `Balance` vs `TotalAmt`; QBO has
  no status field to map.
- **One payment per invoice [9.1].** A one-line, one-invoice payment maps cleanly; a QBO
  payment split over several invoices, or with unapplied credit, needs a decision (reject,
  flag, or model allocations).
- **Payments move on their own [8, 9.2].** Void / delete / shrinking an invoice turn its
  payments into unapplied credit, which QBO then attaches to the customer's next invoice.
  An invoice's balance can change without any write to it, and a freshly created invoice
  may already be part-paid. Changing an invoice's customer in QBO also unapplies its
  payments. A SyncToken jump > 1 after our own write means QBO changed something too.
- **GL mapping [11.2].** QBO posts invoices itself (lines -> item income account, total ->
  A/R; payments A/R -> deposit account). Mapping "GL entries and accounts" can mean mapping
  our revenue categories to QBO items (each on an income account) rather than writing
  journal entries; JournalEntry is only needed for postings that aren't invoices or
  payments. The GeneralLedger report can verify the result.
- **Client rate [12.1].** Keep QBO calls per realm well under 10/s (e.g. a few in flight)
  and treat 429 as retryable after `retry-after`; a sync worker with unbounded parallelism
  would throttle itself.
- **Token storage [12.2].** Rotation wasn't observed; persisting the returned refresh token
  on every refresh (the client's token store already does) covers it either way.
