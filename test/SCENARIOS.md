# Sync scenarios

What the sync must do, as Given / When / Then. Each scenario becomes an integration test
(the sync and its Postgres for real, both systems faked); ★ marks the ones that also run
end-to-end against the real QBO sandbox. `core` is what the brief asks for directly
(its "should handle" list, minimum requirements and edge cases) and is built first;
`extra` comes after. "Invoicing" is our invoicing system (contract:
`docs/invoicing-api-contract.md`), "QBO" is QuickBooks Online.

Every scenario also checks the audit trail: what changed, what the sync did, whether it
succeeded.

## Creation

**C1. Invoice created in invoicing appears in QBO** ★ · core
- Given a customer and an item that are linked to QBO
- When an invoice is created in invoicing
- Then an invoice with the same number, customer, dates and lines exists in QBO, and the
  two are linked

**C2. Invoice created in QBO appears in invoicing** ★ · core
- Given a customer and an item that are linked
- When an invoice is created in QBO
- Then an invoice with QBO's `DocNumber` as its number exists in invoicing, and the two
  are linked

**C3. A new invoice brings its customer along** · core
- Given a customer that exists only in invoicing
- When an invoice for that customer is created in invoicing
- Then the customer is created in QBO first, then the invoice; both are linked

**C4. A new invoice brings its item along** · core
- Given an item (with its income account) that exists only in invoicing
- When an invoice using that item is created in invoicing
- Then the account and item exist in QBO (matched by name, or created), then the invoice;
  each line posts to the mapped income account

**C5. QBO invoice that invoicing can't represent is flagged** · extra
- Given an invoice created in QBO with a non-USD currency, an inventory item, a
  text-only line or a discount line
- When the sync processes it
- Then nothing is created in invoicing and the invoice is flagged as unsupported, with
  the reason

**C6. QBO invoice with sales tax is imported with its tax** ★ · core
- Given an invoice created in QBO with sales tax (e.g. 15.00 + 1.20)
- When the sync processes it
- Then invoicing has the same lines and a tax of 1.20, total 16.20; a payment of 16.20
  in QBO pays it in full on both sides

## Updates

**U1. Edit in invoicing reaches QBO** ★ · core
- Given a linked invoice
- When its memo, due date or lines are changed in invoicing
- Then the QBO invoice has the same values; lines added, changed and removed match

**U2. Edit in QBO reaches invoicing** ★ · core
- Given a linked invoice
- When its memo, due date or lines are changed in QBO
- Then the invoicing invoice has the same values

**U3. The sync's own write is not echoed back** · core
- Given the sync just updated an invoice in one system
- When that system notifies about the change
- Then the sync recognises it as its own and writes nothing back to the other system

**U4. A change that doesn't touch synced fields is ignored** · extra
- Given a linked invoice
- When only a field the sync doesn't map changes (e.g. QBO's email status)
- Then nothing is written to the other side

**U5. The other side changed under the sync's write** · core
- Given the sync is about to update an invoice in one system
- When the write is rejected because the invoice changed meanwhile (stale `SyncToken` in
  QBO, stale `version` in invoicing)
- Then the sync refetches and re-evaluates; it never overwrites the newer version
  blindly (it may turn into a conflict, see F2)

**U6. Invoice number changed in QBO** · extra
- Given a linked invoice
- When its `DocNumber` is changed in QBO (invoicing numbers are immutable)
- Then invoicing keeps its number and the invoice is flagged

**U7. Lines of a taxed invoice edited in invoicing are flagged** · core
- Given a linked invoice with tax set by QBO
- When its lines (or its tax) are changed in invoicing
- Then nothing is written to QBO, which would recompute the tax; the invoice is flagged
  (tax is QBO's; such lines are edited in QBO)

## Void and delete

**V1. Void in invoicing voids in QBO** ★ · core
- Given a linked invoice with no payments
- When it is voided in invoicing
- Then the QBO invoice is voided

**V2. Void in QBO voids in invoicing** ★ · core
- Given a linked invoice with no payments
- When it is voided in QBO
- Then the invoicing invoice is voided

**V3. Void in QBO of a paid invoice** · extra
- Given a linked invoice paid by a linked payment
- When it is voided in QBO (QBO unlinks the payment, its money becomes unapplied)
- Then in invoicing the payment's allocation to that invoice is removed first, then the
  invoice is voided; the payment keeps its amount as unapplied

**V4. Delete in invoicing deletes in QBO** · core
- Given a linked invoice with no payments
- When it is deleted in invoicing
- Then the QBO invoice is deleted and the link is marked deleted

**V5. Delete in QBO deletes in invoicing** ★ · core
- Given a linked invoice
- When it is deleted in QBO
- Then the invoicing invoice is deleted (allocations removed from payments first, as in
  V3)

**V6. Voided invoice brought back to life in QBO is flagged** · extra
- Given a linked invoice that is voided on both sides
- When it is edited in QBO to a non-zero total
- Then invoicing stays void and the invoice is flagged

**V7. Deleted on one side, edited on the other** · core
- Given a linked invoice
- When it is deleted in one system and edited in the other before the sync runs
- Then nothing is deleted or overwritten automatically; it is flagged as a conflict

## Payments

**P1. Payment recorded in invoicing appears in QBO** ★ · core
- Given a linked invoice of 100
- When a payment of 100 allocated to it is recorded in invoicing
- Then a QBO payment of 100 applied to the QBO invoice exists and is linked; the QBO
  invoice balance is 0

**P2. Payment recorded in QBO appears in invoicing** ★ · core
- Given a linked invoice of 100
- When a payment of 40 is recorded against it in QBO
- Then invoicing has a payment of 40 allocated to the invoice; its status is partly paid

**P3. Partial payments add up** · extra
- Given a linked invoice of 100
- When payments of 30, 50 and 20 are recorded (in either system)
- Then both sides show balances 70, 20, 0 and the invoice ends up paid

**P4. One payment over two invoices** · extra
- Given two linked invoices of the same customer
- When one payment of 100 is applied 60 / 40 to them in QBO
- Then invoicing has one payment with two allocations of 60 and 40

**P5. Payment edited** · extra
- Given a linked payment
- When its amount or allocations are changed in either system
- Then the other side matches; invoice balances follow

**P6. Payment deleted or voided in QBO** · core
- Given a linked payment
- When it is deleted or voided in QBO
- Then the invoicing payment is deleted and the invoice balance is restored

**P7. Payment for an invoice that isn't synced yet** · core
- Given an invoice created in QBO whose notification hasn't been processed
- When a payment for it arrives first
- Then the payment waits until the invoice is linked, then syncs; nothing is dropped

**P8. Editing a partially paid invoice** · core
- Given a linked invoice of 100 with 60 paid
- When its total is changed to 80 in either system
- Then both sides show total 80, paid 60, balance 20; an edit written to QBO queues the
  payment's sync, since QBO may move a payment without reporting it

**P9. Total reduced below the paid amount in QBO** · extra
- Given a linked invoice of 100, fully paid
- When its total is reduced to 70 in QBO (QBO shrinks the payment's application to 70
  and leaves 30 unapplied)
- Then in invoicing the allocation becomes 70 first, then the invoice total 70; the
  payment shows 30 unapplied

**P10. Payment for an invoice voided or deleted on the other side** · extra
- Given a payment recorded in one system while its invoice is voided or deleted in the
  other, before either is synced
- When the sync processes them
- Then nothing is written against the closed invoice: the payment is flagged as a
  conflict, with no failed job and no duplicate; once its allocation is removed (by a
  person, or by QBO freeing it on void) the payment syncs and the issue closes

## Duplicates and ordering

**E0. Notifications are only a hint** · core
- Given a notification with an incomplete or outdated payload
- When the sync processes it
- Then it fetches the record's current state and acts on that, never on the payload

**E1. Duplicate webhook** ★ · core
- Given a change already synced
- When the same notification is delivered again
- Then nothing is written a second time

**E2. Same change seen by webhook and by polling** · core
- Given a change whose webhook was processed
- When the same change is also picked up by polling (invoicing feed / QBO CDC)
- Then nothing is written a second time

**E3. Events out of order** · core
- Given an invoice changed twice (A, then B)
- When the notification for B is processed before the one for A
- Then the other side ends up with state B; processing A afterwards changes nothing

**E3a. Delayed notification** · extra
- Given a change that is already synced (picked up by polling)
- When its webhook arrives much later
- Then nothing is written; the state already matches

**E4. Lost webhook** · core
- Given a change whose webhook never arrives
- When the sync polls (invoicing feed / QBO CDC)
- Then the change is synced

**E5. Created and deleted before the sync runs** · extra
- Given an invoice created and then deleted in QBO
- When both notifications are processed
- Then nothing is created in invoicing

**E6. Many events for one invoice at once** · core
- Given several notifications for the same invoice arrive together
- When they are processed
- Then they are applied one at a time, and the final state matches the source

**E7. Forged notification is rejected** · extra
- Given a webhook whose signature doesn't verify (`intuit-signature` for QBO)
- When it reaches the sync
- Then it is rejected and nothing is queued

## Conflicts

**F1. Both systems edit different fields** · core
- Given a linked invoice
- When the memo is changed in invoicing and the due date in QBO, before the sync runs
- Then both changes are merged and both sides end up with the new memo and due date

**F2. Both systems edit the same field differently** ★ · core
- Given a linked invoice
- When its lines are changed in both systems, differently, before the sync runs
- Then neither side is overwritten; the invoice is flagged as a conflict showing both
  versions

**F3. Both systems make the same edit** · extra
- Given a linked invoice
- When the same change is made in both systems
- Then no conflict is raised and nothing is written

**F4. Resolving a conflict** · extra
- Given a flagged conflict
- When an operator picks one side's version
- Then that version is written to the other side and the conflict is closed; a conflict
  over a write that can't go ahead (P10) is refused and closes once the data is fixed

**F5. A conflicted invoice stays parked** · core
- Given a flagged conflict
- When further changes arrive for that invoice
- Then they are recorded but not applied until the conflict is resolved

## Failures

**R1. Timeout after a write to QBO** ★ · core
- Given the sync creates an invoice in QBO
- When QBO creates it but the response is lost (timeout)
- Then the retry yields the same QBO invoice (no duplicate) and the link is stored

**R2. Timeout after a write to invoicing** · core
- Given the sync creates an invoice in invoicing
- When invoicing creates it but the response is lost
- Then the retry yields the same invoice (no duplicate)

**R3. Transient failures are retried** · core
- Given either system answers with 5xx, 429 or a timeout
- When the sync's call fails
- Then it is retried with backoff and eventually succeeds; the audit shows each attempt

**R3a. QBO access token expired** · extra
- Given the QBO access token has expired
- When the sync's call gets 401
- Then the token is refreshed and the call retried; no job is lost

**R4. Permanent failures are not retried** · core
- Given QBO rejects a write as invalid (validation error)
- When the sync's call fails
- Then it is not retried; the job is marked failed with the error, visible through the
  read API; the failed write is in the audit

**R5. Retry after partial success** · core
- Given syncing an invoice needs several writes (customer, item, invoice)
- When the customer write succeeds and the invoice write fails
- Then the retry continues from the invoice; the customer is not created twice

**R6. A system is down for a while** · extra
- Given one system fails every call for some time
- When it comes back
- Then the pending changes are synced; changes that exceeded the retry limit are marked
  failed and can be retried by an operator

## Existing records with no link

**L1. Same invoice exists on both sides** ★ · core
- Given an invoice with the same number, customer and total in both systems, not linked
- When the sync first sees either of them
- Then they are linked; nothing is created

**L2. Same number, different invoice** · core
- Given an invoice number that exists in both systems with a different customer or total
- When the sync first sees either of them
- Then they are not linked and nothing is created; the pair is flagged

**L3. Duplicate numbers in QBO** · extra
- Given two QBO invoices with the same `DocNumber` (QBO allows it)
- When the sync tries to match by number
- Then nothing is linked automatically; the invoices are flagged as ambiguous

**L4. Customers and items are matched by name** · core
- Given a customer or item with the same name in both systems, not linked
- When an invoice referencing it is synced
- Then the existing records are linked instead of new ones being created

**L5. Initial reconciliation** · extra
- Given records on both sides that existed before the sync was connected and never change
- When the sync runs its initial reconciliation
- Then each one is matched (L1-L4) or created on the other side

## Accounts and general ledger

**G1. Accounts, items and customers sync on their own** · extra
- Given a linked account, item or customer
- When it is created, renamed or deactivated in either system
- Then the other side matches, without any invoice involved

**G2. GL postings land on the mapped accounts** ★ · core
- Given a synced invoice (C1) and its payment (P1)
- When QBO's General Ledger report is read
- Then income is credited to the item's mapped income account, and the payment moves
  the amount from A/R to Undeposited Funds

**G3. Manual journal entries in QBO are ignored** · extra
- Given a journal entry created by hand in QBO
- When its webhook arrives
- Then it is acknowledged (200), logged as skipped, and no job is queued and nothing is
  written to invoicing or the audit log

## Audit

**A1. The history of one invoice explains itself** · core
- Given an invoice that went through edits, a retry and a conflict
- When its audit history is read
- Then each entry says what changed (fields, old and new values, which side), what the
  sync did, and whether it succeeded (with attempts and errors)

## Invariants (property-based)

Randomised with `fast-check` over the same fakes: a generated sequence of edits on both
sides, notifications delivered duplicated, reordered or dropped, calls failing at random.
After everything is processed and polled:

**I1. Convergence** · extra
- Every linked pair is equal on both sides, or flagged as a conflict

**I2. No duplicates** · extra
- Every record has exactly one counterpart and one link, however many retries and
  duplicate notifications there were

**I3. Replay writes nothing** · extra
- Processing the whole notification history again writes nothing to either system

## Design choices these scenarios assume

Decided with the sync design:

1. Invoices, payments, customers, items and accounts are synced both ways.
2. Unsupported QBO data (other currencies, inventory items, text-only and discount
   lines) is flagged, not imported (C5). Sales tax is supported as an amount QBO owns:
   imported into invoicing, never written to QBO (C6, U7).
3. Delete maps to delete and void to void, across systems (V1-V5).
4. A void revived in QBO is flagged, not mirrored (V6).
5. Edits to different fields merge; edits to the same field are a conflict (F1, F2). A
   conflict parks the invoice until an operator resolves it (F4, F5).
6. Delete vs edit is always a conflict (V7).
7. QBO's automatic application of a customer's unapplied credit to another invoice is an
   ordinary payment edit (P5); it needs no logic of its own.
8. Matching unlinked records: invoices by number + customer + total, customers and items
   by name (L1-L4).
9. GL: accounts are synced; postings are derived by QBO from invoices and payments
   (G2). Manual journal entries are out of scope (G3).
10. A `DocNumber` change in QBO is flagged, since invoicing numbers are immutable (U6).
