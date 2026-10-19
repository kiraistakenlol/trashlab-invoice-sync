# Decision log

Decisions in the order they were made, with the reasoning at the time. Later entries
may revise earlier ones.

- 2026-10-16 - `assignment.md` (Notion page + assignment email) is the source of truth.
- 2026-10-16 - Earlier unreviewed design draft dropped; design rebuilt step by step.
- 2026-10-16 - Tests written as Given-When-Then in plain Vitest (no Cucumber / Gherkin).
- 2026-10-16 - A simple UI is in scope, mainly to make the demo clear.
- 2026-10-16 - Start with the internal invoicing system.
- 2026-10-16 - Stack: TypeScript on Node (Fastify), PostgreSQL via Kysely, React + Vite for
  the UI, Vitest, Docker Compose. Matches the company's stack (TS / React / Node / SQL).
- 2026-10-16 - Three separate apps in a pnpm monorepo: `invoicing-service`,
  `qbo-sync-service`, `console` (one UI for both), plus `packages/invoicing-contract`.
  Sync is a separate process with its own database (see `design-details.md`).
- 2026-10-16 - QBO transport client is a shared package (`packages/qbo-client`), used by
  `qbo-playground` and later `qbo-sync-service`; token storage pluggable.
- 2026-10-16 - Conventions: knowledge flows downward, minimal
  comments, flag workarounds, resource-shaped API, logging approach (story not plumbing;
  logs are not the audit trail), doc layering. Money is decimal (`numeric(12,2)`, decimal
  string on the wire), not integer cents.
- 2026-10-16 - Git: commit only on explicit request (propose a commit after larger work).
- 2026-10-16 - invoicing-service payments: a payment belongs to a customer and is applied
  to invoices through allocations (split payments and unapplied credit supported, as in
  QBO); void / delete / reductions free allocated money; no automatic credit application.
- 2026-10-16 - invoicing-service model decided: own accounts and items (mapped one-to-one
  to QBO); soft delete; void is final (a QBO revival is flagged); optimistic locking on
  `version`; idempotency key on creates (409 on a different body); outbox with thin
  webhooks plus an events feed. Details in `apps/invoicing-service/DESIGN.md`.
- 2026-10-16 - invoicing-service trimmed to what the sync and demo need: best-effort
  webhooks (sent once, no delivery table or retries; the events feed is the guarantee);
  every operation changes one entity (void / delete / reduction blocked by allocations
  instead of freeing them); no deactivate endpoints, no list paging, no fault injection.
- 2026-10-16 - The invoicing system is not built: the task assumes it exists. Its contract
  (the model and rules decided above) is `docs/invoicing-api-contract.md`; an in-memory
  fake plays it in tests only. `apps/invoicing-service` and `packages/invoicing-contract`
  removed; the console shows sync activity only; the demo runs scripted scenarios against
  the real QBO sandbox.
- 2026-10-16 - Single package, no workspaces and no UI: the repo is the sync service
  (`src/`), the QBO client is `src/qbo`, the invoicing contract `docs/invoicing-api-contract.md`;
  playground scripts run from the root (`pnpm qbo:*`). `apps/console` dropped.
- 2026-10-16 - Scenario list `test/SCENARIOS.md`, marked `core` / `extra`; ★ scenarios
  also run against the sandbox. Property-based invariants (`fast-check`) on top.
- 2026-10-16 - Test approach: fake QBO limited to sandbox-verified behaviour, checked by
  contract tests against both; fresh database per test from a template; tests drive
  delivery, worker and clock (no sleeps); preconditions built through the sync; ★
  scenarios written once for both worlds, sandbox runs pick up QBO changes by polling, with a
  unique run prefix, sequential and cleaned up.
- 2026-10-17 - Sync design: state reconciliation against a per-pair snapshot (three-way
  per field), not event replay; webhooks + polling into one pending job per record, no
  dedup keys; one link table with a neutral-form snapshot, invoice lines as one field;
  conflicts and other undecidable cases are issues that park the pair until both sides
  match or an operator picks a side; stored idempotency keys for creates, version checks for
  updates, echo detection by stored `SyncToken` / `version`; Postgres job queue with
  per-pair leases, dependencies synced inside a job, retries by error class; payments
  re-allocated before invoice void / delete / reduction; matching before every create;
  `sync:reconcile` for pre-existing records.
- 2026-10-17 - Sales tax is a QBO-owned field: imported into invoicing as an amount
  (`tax` added to the contract), never written to QBO; invoicing edits to a taxed
  invoice's lines are flagged. The sandbox's sales tax is assumed impossible to turn off.
- 2026-10-17 - Sync schema: `invoicing_qbo_links`, `sync_jobs`, `sync_issues`, `audit_log`,
  `poll_cursors`. The link row is created before its counterpart and holds the create
  idempotency key. Jobs, issues and audit entries reference a record (system, type, id) plus
  an optional link; one job per record, not per pair - concurrent jobs on a pair are
  made safe by version checks on both systems and on the link. Parked is derived from
  open issues; notifications are audit entries.
- 2026-10-17 - Fake QBO implements the QboClient transport interface; one contract suite checks
  it against the sandbox.
- 2026-10-17 - Payments carry no deposit account (invoicing has none); QBO uses its
  default, Undeposited Funds.
- 2026-10-17 - Pending create fields: before a create the link's snapshot holds the fields
  being created; every retry sends them under the same key, so a replay can't diverge.
- 2026-10-17 - Adoption: an unlinked record equal to a link's pending create fields is that
  create, landed early; it is adopted into the link instead of matched or copied back.
- 2026-10-17 - The QBO CDC cursor is the request time (sandbox records can be future-dated),
  read back with a step-back; a capped response holds it at the last update returned.
- 2026-10-17 - A void or delete blocked by a payment still allocated in invoicing flags the
  invoice instead of failing the job.
- 2026-10-17 - An invoice created in invoicing with tax is not created in QBO but flagged
  (tax is written only from QBO).
- 2026-10-17 - Failed jobs and their last error are exposed through the read API
  (`GET /jobs?status=`), not as an audit action; the audit keeps every write attempt.
- 2026-10-18 - ★ scenarios are one suite function run on two worlds (fake, sandbox); the
  sandbox world learns of QBO changes only by CDC polling with a bounded wait, uses the
  system clock, a unique name prefix per run, and removes its own records afterwards.
- 2026-10-18 - The service is `src/main.ts` over an HTTP invoicing client implementing
  `docs/invoicing-api-contract.md`; no invoicing server is built. QBO tokens live in a file
  (`QBO_CONNECTION_FILE`), fine for one process; several instances need a database token
  store (`TokenStore` is pluggable).
- 2026-10-18 - Operator resolution applies to conflict issues only: `PATCH /issues/{id}` with
  `invoicing` or `qbo` stores the loser's current fields as the link's snapshot and queues a
  job, so the winner is copied through the normal write path; a loser edited again meanwhile
  opens a new conflict.
- 2026-10-18 - `PATCH /jobs/{id}` retries a failed job (attempts reset, due now); refused when
  the record already has a pending job.
- 2026-10-18 - A journal-entry webhook is acknowledged and logged as skipped; nothing is
  queued and CDC never asks for journal entries.
- 2026-10-18 - Payments are reconciled before any invoicing write that lowers an invoice's
  total below what is allocated, not only before a void or delete.
- 2026-10-18 - An invoice job that writes to QBO queues the linked payments allocated to the
  invoice, since only QBO moves payments implicitly.
- 2026-10-18 - Operator conflict resolution refuses a void-vs-edit resolved to the edit
  (`cannot_restore`): voids are final in invoicing and QBO has no unvoid.
- 2026-10-19 - A payment allocated to an invoice that is voided or deleted on the target side
  is flagged as a conflict, not written (found by the property-based invariants).
- 2026-10-19 - Linked payments are re-queued only after the sync writes an invoice to QBO
  (only QBO moves payments implicitly).
- 2026-10-19 - QBO renames deactivated customers, accounts and items "<name> (deleted)" and
  frees the name; the sync strips the suffix; no duplicate-name case arises.
- 2026-10-19 - Two QBO invoices with the same number are ambiguous from either side.
