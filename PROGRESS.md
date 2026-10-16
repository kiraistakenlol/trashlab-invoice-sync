# Progress

Direction and progress from now to submission. Requirements: `TASK.md`.

## Where we stand

_Last updated: 2026-10-16_

| Area                                   | Status         |
|----------------------------------------|----------------|
| Task spec captured (`TASK.md`)         | done           |
| System overview + repo structure       | done           |
| Repo directories initialized           | done           |
| Invoicing system - assumed contract    | done           |
| QBO sandbox account + OAuth            | done           |
| QBO behaviour checks                   | done           |
| Test scenarios (Given-When-Then)       | not started    |
| Sync design                            | not started    |
| Sync implementation                    | not started    |
| Tests                                  | not started    |
| README, design write-up                | not started    |
| Demo video, ZIP, submission            | not started    |

**Now:** QBO exploration done (`qbo-playground/qbo-spec.md`, `sync-notes.md`); the
invoicing system is assumed, not built - its contract is
`docs/INVOICING.md`.
**Next:** test approach (fake invoicing system, fake QBO, e2e on the sandbox, scenario
list), then the sync design.
**Blockers:** none.

## Direction

- The invoicing system is assumed and simulated by an in-memory fake in tests; all build
  effort goes into the sync service between it and the QBO sandbox.
- Tests first for the sync: Given-When-Then scenarios in plain Vitest, plus a markdown
  scenario list.
- Design decided step by step and reviewed; nothing carried over unreviewed.

## Milestones

1. [x] Invoicing system: assumed contract written (`docs/INVOICING.md`).
2. [x] QBO sandbox: developer account, OAuth helper, behaviour checks recorded.
3. [ ] Test scenarios (Given-When-Then) for the edge cases in `TASK.md`.
4. [ ] Sync design.
5. [ ] Sync implementation + tests (fake QBO for deterministic tests, e2e on the sandbox).
6. [ ] README, design write-up, demo video, ZIP, submit.

## Decisions log

- 2026-10-16 - `TASK.md` (Notion page + assignment email) is the source of truth.
- 2026-10-16 - Earlier unreviewed design draft dropped; design rebuilt step by step.
- 2026-10-16 - Tests written as Given-When-Then in plain Vitest (no Cucumber / Gherkin).
- 2026-10-16 - A simple UI is in scope, mainly to make the demo clear.
- 2026-10-16 - Start with the internal invoicing system.
- 2026-10-16 - Stack: TypeScript on Node (Fastify), PostgreSQL via Kysely, React + Vite for
  the UI, Vitest, Docker Compose. Matches the company's stack (TS / React / Node / SQL).
- 2026-10-16 - Three separate apps in a pnpm monorepo: `invoicing-service`,
  `qbo-sync-service`, `console` (one UI for both), plus `packages/invoicing-contract`.
  Sync is a separate process with its own database (see `DESIGN.md`).
- 2026-10-16 - QBO transport client is a shared package (`packages/qbo-client`), used by
  `qbo-playground` and later `qbo-sync-service`; token storage pluggable.
- 2026-10-16 - Conventions adopted from ohmyvpn: knowledge flows downward, minimal
  comments, flag workarounds, resource-shaped API, logging approach (story not plumbing;
  logs are not the audit trail), doc layering. Money is decimal (`numeric(12,2)`, decimal
  string on the wire), not integer cents.
- 2026-10-16 - Git: commit only on explicit request (propose a commit after larger work);
  no AI signatures.
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
  (the model and rules decided above) is `docs/INVOICING.md`; an in-memory
  fake plays it in tests only. `apps/invoicing-service` and `packages/invoicing-contract`
  removed; the console shows sync activity only; the demo runs scripted scenarios against
  the real QBO sandbox.
- 2026-10-16 - Single package, no workspaces and no UI: the repo is the sync service
  (`src/`), the QBO client is `src/qbo`, the invoicing contract `docs/INVOICING.md`;
  playground scripts run from the root (`pnpm qbo:*`). `apps/console` dropped.
