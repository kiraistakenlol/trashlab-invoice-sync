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
- **Shared business key [5.2, 6.1].** `DocNumber` (≤ 21 chars) can carry our invoice number,
  which helps match records that exist in both systems without a link. QBO doesn't enforce
  uniqueness, so our side would have to.
- **Customer mapping [5.1].** Invoices need a `CustomerRef`, so customers need mapping too.
  `DisplayName` is not a stable key (case-insensitive collisions, renamed on deactivation),
  so the link should store the QBO `Id`.
- **Line mapping [6.3].** Either keep our-line -> QBO line `Id` links, or resend all lines
  without Ids on each update (simpler; QBO line Ids then change on every write).
- **Echo detection [6.1].** `SyncToken` moves only on real changes. If we record the token
  our own write returned, a later event carrying that same token is our echo; a higher one
  means someone else changed the record. To be confirmed against webhooks / CDC.
- **Not-found vs deleted [3.2].** A `610` on GET may mean "deleted". Confirm through CDC
  (pending) before treating the record as deleted.
