# Two-Way Invoice Sync

<!-- last-updated: 2026-10-17 -->

## Overview

Take-home exercise: a service that keeps invoices and payments in sync between our own
invoicing system and QuickBooks Online (QBO), against the real QBO sandbox. This file holds
everything needed to continue the work in a fresh session.

⚠ The repo is submitted to the company as a ZIP. Keep everything in it professional: no
recruiting, salary or personal notes.

## Development state

- Not deployed anywhere; runs locally only. Nothing is in production.
- Local databases are disposable: reset them freely.
- Breaking changes are fine; nothing depends on this code yet.
- Commit directly to `master` (private GitHub remote `kiraistakenlol/trashlab-invoice-sync`
  as backup).
- Design is built decision by decision and reviewed with the user before code. Don't
  build ahead of an agreed design.

## Critical rules

- **KISS / YAGNI / DRY.** The simplest thing that works; nothing for hypothetical futures.
  The task values correctness and judgment over surface area.
- **Kill dead code** the moment it's dead. No commented-out code, no "just in case".
- **Single source of truth** for every fact - see "Sources of truth" below. Derive, don't
  duplicate.
- **Pick one of everything:** pnpm (one lockfile), one formatter, one way to do each thing.
- **Recurring work becomes a named command** (package script), not a remembered
  incantation.
- **Docs must not drift.** When something changes, update the doc that owns it in the same
  commit; keep `last-updated` markers current.
- **Knowledge flows downward only.** A component knows its own job and contract, never its
  callers or where it runs; what it needs comes in as config or an argument. Same for
  comments: never mention callers or peers. (E.g. `src/qbo` knows nothing about the
  sync service.)
- **Minimal comments; the code carries the meaning.** One-line module header (what this
  is); inline comments only for the genuinely non-obvious, next to the line. Say what a
  thing does, not what it doesn't. Never reference other files/docs or labels that only
  resolve elsewhere ("Phase 2").
- **Flag workarounds explicitly.** Before taking a shortcut, say it is one, why it isn't
  the long-term answer, and what the clean path is - then let the user decide.
- **Build for the agent's agency.** Prefer paths with a programmatic handle (API, CLI,
  script) over manual-only ones.
- **Nothing environment-specific is hardcoded.** URLs, ids, intervals come from config.
- **Never commit secrets.** Config in `.env` (gitignored), documented in `.env.example`.
  Runtime state such as tokens never goes in `.env`.
- **Code is the ultimate source of truth.** Docs orient and may lag; verify specifics in
  code before relying on them.
- **Personal context** (local paths, private notes, IDE setup) goes in the gitignored
  `CLAUDE.local.md`, never here.

## Sources of truth

| Fact                               | Where                                                      |
|------------------------------------|------------------------------------------------------------|
| Requirements                       | `TASK.md` (task page verbatim + assignment email)          |
| Architecture and decisions         | `DESIGN.md`                                                |
| Progress, next steps, decision log | `PROGRESS.md` ("Where we stand" at the top)                |
| QBO API behaviour (verified)       | `qbo-playground/qbo-spec.md`; tracker `qbo-playground/EXPLORATION.md` |
| QBO-driven design inputs (candidates) | `qbo-playground/sync-notes.md`                      |
| Invoicing system (assumed contract) | `docs/INVOICING.md`                                       |
| Database schema                    | `db/baseline.sql`                                          |
| Config variables                   | `.env.example`                                             |

## The brief (condensed - `TASK.md` wins on any difference)

- Sync invoices between our invoicing system and QBO via the **real QBO sandbox APIs**
  (no mocking the sync).
- Handle: creation · updates · deletions / voids · payment status changes · duplicate
  events · conflicting edits in both systems.
- Assume: both sides have APIs and webhook-like notifications · events duplicated,
  delayed, out of order · payloads incomplete (refetch) · API calls fail / time out ·
  manual edits on both sides.
- Minimum requirements: (1) mapping - invoices, payments, GL entries and accounts;
  (2) sync logic - ingest from either side, fetch current state, apply safely;
  (3) idempotency; (4) conflict handling - resolve or flag; (5) auditability - what
  changed, what was done, did it succeed; (6) failure handling - retries, transient
  failures, timeouts, partial success.
- Edge cases (address at least some): duplicate webhook delivery · out-of-order events ·
  same invoice edited in both systems · delete vs void · editing partially paid invoices ·
  timeout after write · retry after partial success · existing records on both sides with
  no link.
- Evaluated on: systems design · data modeling · idempotency · conflict resolution ·
  reliability under partial failure · test quality · written tradeoff reasoning.
- Priority (email): accuracy and realistic handling of integration mess over feature
  count; core issues first; tests for the most important edge cases.
- Deliverables: ZIP of source (with `.git`, no secrets) · README (setup + assumptions) ·
  design write-up (decisions + trade-offs) · demo video against the sandbox (optional,
  highly valued). An actionable feedback round by email follows the first submission.

## Architecture

One package: the repo is the sync service. It talks to the invoicing system and to QBO
only through their APIs and change notifications. The invoicing system is assumed, not
built: its contract is `docs/INVOICING.md`, and in tests an in-memory fake plays it. No
UI. Details and reasoning: `DESIGN.md`.

| Path             | What it is                                                         |
|------------------|--------------------------------------------------------------------|
| `src/`           | The sync service: webhook intake, job worker, links, audit log; own DB |
| `src/qbo/`       | QBO transport: OAuth, token refresh, requests, raw responses; pluggable token store |
| `test/`          | Scenario tests, fakes (invoicing system, QBO), e2e against the sandbox |
| `qbo-playground/`| Scripts to explore and verify QBO sandbox behaviour, plus findings |

**Stack (locked):** TypeScript on Node (Fastify), PostgreSQL via Kysely, Vitest, Docker
Compose, pnpm. Matches the company's stack (TS / Node / SQL).

## Project structure

```
src/
  qbo/                    QBO transport client
db/
  baseline.sql            the sync service's database schema
test/
  SCENARIOS.md            what the sync must do, as Given / When / Then
docs/
  INVOICING.md            the assumed invoicing system contract
qbo-playground/
  src/auth.ts             one-time OAuth consent -> .qbo-connection.json (`pnpm qbo:auth`)
  src/call.ts             ad-hoc API calls (`pnpm qbo:call ...`)
  src/setup.ts            wires src/qbo to .env config + file token store
  src/webhook-server.ts   local webhook receiver -> webhooks.log (`pnpm qbo:webhooks`)
  src/explore/            one script per experiment (`pnpm qbo:explore NN-...`)
  EXPLORATION.md          QBO exploration tracker
  qbo-spec.md             verified QBO behaviour, project-agnostic
  sync-notes.md           design inputs for the sync that came out of the exploration
TASK.md                   requirements (source of truth)
DESIGN.md                 architecture and decisions
PROGRESS.md               where we stand, milestones, decision log
.env.example              config variables
```

## Development

Prerequisites: Node ^22.15 or ≥ 23.8 (`.nvmrc`: 24), pnpm 10, Docker.

```bash
pnpm install
pnpm format                                   # prettier --write (format:check verifies)
pnpm lint
pnpm typecheck
pnpm test                                     # unit + scenario tests (default project)
pnpm test:e2e                                 # e2e project, real sandbox (needs `pnpm qbo:auth` once)
pnpm check                                    # format:check + lint + typecheck + test
pnpm qbo:auth                                 # connect the QBO sandbox (opens consent URL)
pnpm qbo:call query "select * from Invoice maxresults 5"
```

`pnpm check` is the gate before every commit. Planned: `dev` (run with reload).

### Configuration

| Variable              | Purpose                                         |
|-----------------------|-------------------------------------------------|
| `QBO_CLIENT_ID`       | Intuit app client id (Development keys)         |
| `QBO_CLIENT_SECRET`   | Intuit app client secret                        |
| `QBO_REDIRECT_URI`    | OAuth redirect, must match the app settings exactly |
| `QBO_ENVIRONMENT`     | `sandbox` or `production`                       |
| `QBO_WEBHOOK_VERIFIER_TOKEN` | Verifies `intuit-signature` on webhook deliveries |

QBO connection state (realm id + tokens) lives in `qbo-playground/.qbo-connection.json`
(gitignored, rewritten on every refresh). Sandbox company: "Sandbox Company US 28a6".
Machine-specific scratch files go in a gitignored `local/` directory.

## Conventions

### Code style (TypeScript)

- Prettier: no semicolons, single quotes, 2-space indent, trailing commas `es5`, 100-col
  width, LF.
- `strict` TypeScript plus `noUnusedLocals`, `noUnusedParameters`,
  `noFallthroughCasesInSwitch`.
- `import type { ... }` for type-only imports.
- Enums (TS string unions) over magic strings/numbers.
- No stray `console.log` in services - use the app logger. Scripts in `qbo-playground`
  may print.
- Unused variables are prefixed `_`.
- Files `kebab-case.ts`.

### Services (Fastify)

- Layers: routes (HTTP + validation) -> services (logic) -> repositories (Kysely queries).
  Routes stay thin.
- Resource-shaped endpoints (`GET /links/{id}`, `PATCH /conflicts/{id}`), never
  named after a caller.
- Response envelope: `{ "data": ... }`, lists `{ "data": [...], "meta": { ... } }`, errors
  `{ "error": { "code": "...", "message": "..." } }`.
- `GET /health` on every service.

### Logging

- pino (Fastify's logger): structured JSON; `pino-pretty` locally, plus a gitignored
  `logs/<app>.log` an agent can search.
- Log the story, not the plumbing: decisions, branches, state changes, errors with
  context. Low-level clients (`src/qbo`, HTTP adapters) stay quiet except on failure.
- Correlation fields on every line of a sync flow: `eventId`, `jobId`, `entity`,
  `entityId`, `qboId`, `intuitTid`.
- Never log secrets: `authorization` headers, tokens, client secret, webhook signatures
  (pino redaction).
- Logs are not the audit trail. "What changed, what was done, did it succeed" is data in
  the sync service's audit table, exposed by its read API and asserted in tests.

### Database

- `db/baseline.sql` is the schema's source of truth; no migration
  history while there is no data to keep. Reset = drop, recreate, apply baseline, seed.
- Tables plural `snake_case`; columns `snake_case`; PK `id uuid`; standard `created_at`,
  `updated_at`.
- Timestamps `timestamptz`, UTC, serialized with `Z`.
- Money is never a float: `numeric(12,2)` in the DB, a decimal string on the wire
  (`"150.00"`), decimal arithmetic in code (never JS `number` math). Matches QBO's
  decimal amounts.
- Enums stored as plain `text` (no Postgres `ENUM`).

### Tests

- Vitest. Sync scenarios written as Given / When / Then (structure in the test, plus a
  markdown scenario list); no Cucumber / Gherkin.
- Deterministic tests use a fake QBO client; a separate e2e run hits the real sandbox.

### Git

- Conventional commits: `type(scope): description` (scope optional), types `feat | fix |
  docs | refactor | test | chore | style | perf`; imperative, subject under ~70 chars.
- **No AI signatures** (no `Co-Authored-By`, no "Generated with" footers).
- **Commit only when the user asks.** When a larger piece of work is done, propose a
  commit (summary + message) instead of making it.
- Run the check gate before committing (once it exists).

### Docs

- This file is the root index: high-level picture and pointers. A new fact earns a
  pointer, not a paragraph. Each app's `README.md` (once it exists) is its mental model.
- References point downward only; every doc reads correctly on its own.
- Specs state facts, not recommendations: `qbo-spec.md` describes QBO; what it means for
  us goes in `sync-notes.md` / `DESIGN.md`.
- Durable docs describe the current state, not history (history is in git and the
  `PROGRESS.md` decision log). No volatile values; no self-referential links.

## Keeping this file current

Update this file in the same commit as any change to structure, commands, conventions or
sources of truth, and bump `last-updated`. After larger changes, run the `update-claude`
skill to reconcile it with the repo.
