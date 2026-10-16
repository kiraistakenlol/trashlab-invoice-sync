# Progress

Direction and progress from now to submission. Requirements: `TASK.md`.

## Where we stand

_Last updated: 2026-10-16_

| Area                                   | Status         |
|----------------------------------------|----------------|
| Task spec captured (`TASK.md`)         | done           |
| System overview + repo structure       | done           |
| Repo directories initialized           | done           |
| Internal invoicing system - entities   | draft, parked  |
| Internal invoicing system - API + UI   | not started    |
| QBO sandbox account + OAuth            | done           |
| QBO behaviour checks                   | in progress    |
| Test scenarios (Given-When-Then)       | not started    |
| Sync design                            | not started    |
| Sync implementation                    | not started    |
| Tests                                  | not started    |
| README, design write-up                | not started    |
| Demo video, ZIP, submission            | not started    |

**Now:** QBO deep dive in a separate session - tracker `qbo-playground/EXPLORATION.md`,
output `qbo-playground/qbo-spec.md`.
**Next:** back to the invoicing-service open questions
(`apps/invoicing-service/DESIGN.md`), then build it.
**Blockers:** none.

## Direction

- Build our own internal invoicing system first (API + simple UI, the UI also serves the
  demo), then the sync service between it and the QBO sandbox.
- Tests first for the sync: Given-When-Then scenarios in plain Vitest, plus a markdown
  scenario list.
- Design decided step by step and reviewed; nothing carried over unreviewed.

## Milestones

1. [ ] Internal invoicing system: entities, API, simple UI, change notifications.
2. [ ] QBO sandbox: developer account, OAuth helper, behaviour checks recorded.
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
