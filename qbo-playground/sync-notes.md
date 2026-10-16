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
- **Echo detection [6.1, 14.3].** Our own writes come back as webhooks, and a webhook has no
  `SyncToken`, so every event means "refetch". If we record the token our write returned,
  a refetched record with that same token is our echo; a higher one means something else
  changed it (a person, or QBO itself via payments, 9.2). No-op writes produce no event.
- **Idempotent writes [7].** A `requestid` per intended write (e.g. derived from our job id,
  ≤ 50 chars) makes a retry after a timeout safe. Because a replay returns the old
  response and ignores the body, the key must change whenever the intended write changes
  (new SyncToken, new content); reusing a key for a different write silently does nothing.
  Keys are scoped per entity type, not per record, so a key must be unique across all
  writes of that type (a random UUID per intended write, stored with the job, or one
  derived from our record id + version); a returned `Id` other than the one we wrote is a
  sign of a key collision. 425 means "still in flight" - retry later with the same key.
- **Not-found vs deleted [3.2, 8.2, 10].** A `610` on GET means the id doesn't exist or was
  deleted; QBO doesn't tell which. For a linked record it means deleted; CDC's
  `status: "Deleted"` stub confirms it.
- **CDC as a safety net [10].** CDC gives current state only and is fast (< 1 s), so a
  periodic CDC poll from a stored cursor can catch anything webhooks missed. The cursor
  must step back (changedSince is exclusive and timestamps are whole seconds) and the
  apply step must tolerate seeing a record again.
- **Detecting a void [8.1, 14.3].** The webhook `Void` operation is the only explicit
  signal; the record itself has no flag (CDC and GET show only zero lines and a "Voided"
  note). An event missed and recovered via CDC loses that signal, so a fallback rule
  ("all lines zero + note starts with Voided") may be needed. A voided invoice can also
  come back to life, so "voided" is not terminal.
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
- **Invoice changes without Invoice events [14.3].** Payments change an invoice's balance
  and SyncToken but only emit Payment events. Options: on a Payment event, refetch the
  invoices it links (and those it used to link - a deleted payment no longer says which);
  or rely on a CDC poll to catch invoice balance changes.
- **Writing lines to taxed invoices [5.2, 15].** Any invoice saved in the QBO UI carries
  `TxnTaxCodeRef`, and from then on a line update without it fails with `6000`. A sync
  that writes lines must send `TxnTaxCodeRef` whenever the current record has one. With
  a tax-free (`NON`) scope that drops QBO's tax and the code, so pushing our lines to an
  invoice that QBO had taxed changes its total (inferred from 5.2; not tried on a taxed
  UI invoice). Alternatives: flag such invoices instead of overwriting, or carry tax.
- **Tax on QBO-side invoices [15].** Invoices created in the QBO UI include sales tax
  (8 % here) even with non-taxable lines. With a tax-free scope on our side, such an
  invoice's total won't match its lines: accept QBO's `TotalAmt` as the amount owed, or
  flag it.
- **Who changed it [15].** `LastModifiedByRef` can't separate our writes from UI edits;
  only our own record of the SyncToken we produced can.
- **Webhook dedup [14.4].** Intuit retries a failed delivery (7 times in ~27 min, backoff)
  with a new `intuit-t-id` each time, so dedup must key on entity + id + operation +
  `lastUpdated` - or not be needed at all if the handler only records "refetch X" and the
  apply step is idempotent. Answer 200 fast and process asynchronously.
- **Webhooks are lossy [14.4].** An event is dropped after ~27 min of failed deliveries,
  and after a longer outage deliveries stopped entirely (cause unconfirmed). Webhooks can
  only be a fast path; a periodic CDC poll from a stored cursor has to be the guarantee.
