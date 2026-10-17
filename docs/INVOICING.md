# The invoicing system - assumed contract

The sync connects QBO with "our" invoicing system. The task assumes that system exists;
it is not part of this repo. This document states what the sync assumes about it: its
data, its API and its change notifications. In tests the system is played by an in-memory
fake that implements exactly this contract, including its failure modes.

## Data

| Entity       | Fields                                                              |
|--------------|---------------------------------------------------------------------|
| Account      | name, version, deactivated at                                       |
| Item         | name, income account, version, deactivated at                       |
| Customer     | name, email, version, deactivated at                                |
| Invoice      | number (e.g. `INV-0042`), customer, issue date, due date, memo, lines, tax, version, voided at, deleted at |
| Invoice line | id, item, description, quantity, unit price, amount, position       |
| Payment      | customer, amount, date, allocations, version, deleted at            |
| Allocation   | invoice, amount                                                     |

Every record has an `id` (uuid) and `created_at` / `updated_at` (UTC). Money is a decimal
string with 2 places (`"150.00"`), single currency (USD), no tax calculation, no discounts.

### Accounts and items

An item is an entry in the catalogue of things sold ("Weekly cart pickup", "Late fee").
Each invoice line sells one item; the item's income account is where that line's revenue
is booked. Accounts are income accounts.

- Names of accounts, items and customers are unique ignoring case.
- They are never deleted; `deactivated_at` marks a deactivation.
- Items carry no price; every line carries its own unit price.

Why: QBO posts each sales line to its item's income account and has no per-line account.
Items mapped one-to-one to QBO items let lines round-trip without loss; mapping lines to
accounts alone would collapse different QBO items that share an income account.

### Invoices

- `number` is unique ignoring case, at most 21 characters, and never changes - the shared
  business key with QBO (`DocNumber`).
- Issue and due dates are required; `amount` = quantity × unit price exactly; the total
  is ≥ 0; line ids are stable across edits.
- `tax` is an amount the system records but doesn't calculate (default `"0.00"`); it adds
  to the total.
- **Void is final**: a voided invoice can't be edited or reopened. (QBO lets a voided
  invoice be edited back to life; the sync flags that instead of mirroring it.)
- **Delete is soft**: a deleted invoice or payment is still returned by a read by id,
  marked deleted - "deleted" is distinguishable from "never existed".
- Status is derived, not stored: `open` / `partly_paid` / `paid` / `void` / `deleted`.

### Payments and allocations

A payment records money received from a customer; its allocations record which invoices
it pays. One payment can pay several invoices, part of an invoice, or nothing yet.

| Derived value       | Definition                                          |
|---------------------|-----------------------------------------------------|
| invoice total       | sum of its line amounts + tax                       |
| invoice paid        | sum of allocations to it                            |
| invoice balance     | total - paid                                        |
| payment unapplied   | payment amount - sum of its allocations             |

- An allocation's invoice belongs to the payment's customer.
- A payment's allocations total at most its amount; an invoice's allocations total at
  most its total.
- **Every operation changes one record.** Voiding or deleting an invoice that has
  allocations, or reducing its total below what is allocated, is rejected; allocations are
  changed on the payments first.
- Credit is never applied automatically; applying it means replacing a payment's
  allocations.
- Payments have no void state; a QBO payment void maps to a delete.
- Allocation changes bump the payment's version, not the invoice's.

Why: QBO's model is the same (a payment's lines are its allocations; void, delete and
reductions turn applied money into unapplied credit), so every QBO payment maps
one-to-one. QBO frees allocations implicitly; here it takes an explicit payment change,
so a write never has hidden side effects. To mirror a QBO void, the sync updates the
payments before voiding the invoice.

## API

Resource-shaped HTTP API with the `{ "data": ... }` / `{ "error": ... }` envelope:

- Invoices: create (with lines; `number` optional, generated when omitted), read, list
  (filters `customerId`, `number`), replace header and lines (lines with an id updated, without one
  added, omitted ones removed), void, delete.
- Payments: create, read, list, replace (including `allocations: [{ invoiceId, amount }]`),
  delete.
- Accounts, items, customers: create, read, list, update.

Write rules:

- **Optimistic locking.** Every update, void and delete carries the `version` it was based
  on; a mismatch is rejected (409) with the current version.
- **Idempotent creates.** Every create requires an `Idempotency-Key` header. A replay with
  the same body returns the original response; the same key with a different body is
  rejected (409).
- Rule violations are rejected (409 / 422) and change nothing.

## Change notifications

- Every change produces an event: event id, entity type, entity id, kind (`created` /
  `updated` / `voided` / `deleted`), the entity's new version.
- Events are sent as webhooks, **best effort**: they can be duplicated, delayed, arrive out
  of order or be lost, and carry no entity data - receivers refetch.
- The same events are readable in order from a feed (`GET /events?after=<cursor>`), so a
  receiver catches up on anything a webhook missed. Webhooks are a hint, the feed is the
  guarantee - the same stance the sync takes towards QBO (webhooks + CDC).
