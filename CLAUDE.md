# Two-Way Invoice Sync

<!-- last-updated: 2026-10-19 -->

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
| Requirements                       | `docs/assignment.md` (task page verbatim + assignment email) |
| Architecture and decisions         | `docs/design-details.md`                                   |
| Decision log                       | `docs/decision-log.md`                                     |
| QBO API behaviour (verified)       | `qbo-playground/qbo-spec.md`; tracker `qbo-playground/EXPLORATION.md` |
| QBO-driven design inputs (candidates) | `qbo-playground/sync-notes.md`                      |
| Invoicing system (assumed contract) | `docs/invoicing-api-contract.md` |
| Database schema                    | `db/baseline.sql`                                          |
| Config variables                   | `.env.example`                                             |

## The brief (condensed - `docs/assignment.md` wins on any difference)

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
built: its contract is `docs/invoicing-api-contract.md`, and `invoicing-sim/` implements it
in memory - in process for tests (with failure controls), over HTTP for local runs and the
demo. No UI. Details and reasoning: `docs/design-details.md`.

| Path             | What it is                                                         |
|------------------|--------------------------------------------------------------------|
| `src/`           | The sync service: webhook intake, job worker, links, audit log; own DB |
| `src/qbo/`       | QBO transport: OAuth, token refresh, requests, raw responses; pluggable token store; typed entity API |
| `invoicing-sim/` | The invoicing contract in memory: tests use it in process, `pnpm invoicing:dev` serves it over HTTP |
| `demo/`          | `pnpm demo`: an end-to-end walk-through against the running service and the sandbox |
| `test/`          | Scenario tests, fakes (QBO), sandbox runs |
| `qbo-playground/`| Scripts to explore and verify QBO sandbox behaviour, plus findings |

**Stack (locked):** TypeScript on Node (Fastify), PostgreSQL via Kysely, Vitest, Docker
Compose, pnpm. Matches the company's stack (TS / Node / SQL).

## Project structure

```
src/
  main.ts                 entry point: config, logger, service, signal handling
  service.ts              wiring: sync context, HTTP server, worker, poll loop
  config.ts               service config from environment variables
  logger.ts               pino logger with credential redaction
  clock.ts                Clock interface and the system clock
  money.ts                decimal money helpers (no JS number math)
  db/                     Kysely table types and createDb for the schema
  invoicing/              invoicing system types, client interface, errors, HTTP client
  qbo/                    QBO transport client, token stores, typed entity API
  store/                  repositories: links, jobs, issues, audit log, poll cursors
  sync/                   intake, polling, job worker, the reconcile engine, mappers
    specs/                per-entity rules (catalogue, invoice, payment)
  http/                   Fastify server: webhooks, health, read API
  cli/                    operator commands (`db-reset.ts`, `reconcile.ts`)
db/
  baseline.sql            the sync service's database schema
invoicing-sim/
  invoicing.ts            in-memory invoicing system: the contract's rules, events, failure controls
  server.ts               the contract's HTTP API over it (routes, bearer auth, envelopes)
  main.ts                 serves it on INVOICING_API_URL, sends each change to the service's webhook
demo/
  run.ts                  walk-through: create, edit in QBO, pay, conflict, resolve, audit
test/
  SCENARIOS.md            what the sync must do, as Given / When / Then
  harness/                per-test Postgres (template database), bounded-wait helper,
                          scenario worlds on a shared core (fakes + manual clock, or the
                          sandbox + system clock), qbo-actor (a person in QBO), sandbox client
  scenarios/              scenario tests, one file per SCENARIOS.md group; the ★ suite
                          (`star.ts`) runs on the fake world and the sandbox world
  fakes/                  in-memory QBO, with failure controls
  invoicing-sim/          the invoicing simulator: its rules, and the HTTP client against its server
  invariants/             property-based sync invariants (fast-check)
  qbo-contract/           QBO behaviour suite, run against the fake and the sandbox
  unit/                   unit tests for src/, mirroring its paths
docs/
  design-writeup.md       design write-up: the components, decisions and trade-offs
  design-details.md       the full design: every rule, the data model, known limits
  invoicing-api-contract.md  the assumed invoicing system contract
  requirements-coverage.md  each assignment requirement: how met, code, tests
  how-it-was-built.md     how the work went, step by step
  decision-log.md         dated decisions
  assignment.md           requirements (source of truth)
qbo-playground/
  src/auth.ts             one-time OAuth consent -> .qbo-connection.json (`pnpm qbo:auth`)
  src/call.ts             ad-hoc API calls (`pnpm qbo:call ...`)
  src/setup.ts            wires src/qbo to .env config + the connection file
  src/webhook-server.ts   local webhook receiver -> webhooks.log (`pnpm qbo:webhooks`)
  src/explore/            one script per experiment (`pnpm qbo:explore NN-...`)
  EXPLORATION.md          QBO exploration tracker
  qbo-spec.md             verified QBO behaviour, project-agnostic
  sync-notes.md           design inputs for the sync that came out of the exploration
README.md                 what it is, local setup, assumptions
.env.example              config variables
docker-compose.yml        Postgres for running the service locally
```

## Development

Prerequisites: Node ^22.15 or ≥ 23.8 (`.nvmrc`: 24), pnpm 10, Docker.

```bash
pnpm install
pnpm format                                   # prettier --write (format:check verifies)
pnpm lint
pnpm typecheck
pnpm test                                     # offline project: everything but sandbox.test.ts
pnpm test:sandbox                             # sandbox project: sandbox.test.ts files (needs `pnpm qbo:auth` once)
pnpm check                                    # format:check + lint + typecheck + test
pnpm qbo:auth                                 # connect the QBO sandbox (opens consent URL)
pnpm qbo:call query "select * from Invoice maxresults 5"
docker compose up -d                          # Postgres for the service (DATABASE_URL)
pnpm db:reset                                 # drop + recreate DATABASE_URL's database, apply baseline
pnpm sync:reconcile                           # queue a job for every record on both sides (initial reconciliation)
pnpm dev                                      # run the service with reload; pretty logs, JSON in logs/sync.log
pnpm start                                    # run the service (JSON logs on stdout)
pnpm invoicing:dev                            # the invoicing system in memory, over HTTP on INVOICING_API_URL
pnpm demo                                     # end-to-end walk-through (service and invoicing:dev running)
```

`pnpm check` is the gate before every commit. `dev`, `start`, `invoicing:dev`, `demo`, `db:reset` and `sync:reconcile` read `.env`
through Node's `--env-file-if-exists`; variables already set in the shell win.

### Configuration

| Variable              | Purpose                                         |
|-----------------------|-------------------------------------------------|
| `DATABASE_URL`        | The sync service's Postgres                     |
| `PORT`                | HTTP port (default 3000)                        |
| `LOG_LEVEL`           | pino level (default `info`)                     |
| `INVOICING_API_URL`   | Base URL of the invoicing system's API          |
| `INVOICING_API_TOKEN` | Bearer token for the invoicing API              |
| `QBO_CLIENT_ID`       | Intuit app client id (Development keys)         |
| `QBO_CLIENT_SECRET`   | Intuit app client secret                        |
| `QBO_REDIRECT_URI`    | OAuth redirect, must match the app settings exactly |
| `QBO_ENVIRONMENT`     | `sandbox` or `production`                       |
| `QBO_WEBHOOK_VERIFIER_TOKEN` | Verifies `intuit-signature` on webhook deliveries; unset turns the QBO webhook route off (polling only) |
| `QBO_CONNECTION_FILE` | QBO connection state `pnpm qbo:auth` writes; the service reads and refreshes it |
| `WORKER_CONCURRENCY`  | Jobs run in parallel (default 2)                |
| `WORKER_IDLE_MS`      | Worker wait when no job is due (default 1000)   |
| `POLL_INTERVAL_MS`    | Invoicing feed + QBO CDC poll interval (default 60000) |

QBO connection state (realm id + tokens) lives in the file `QBO_CONNECTION_FILE` names
(default `qbo-playground/.qbo-connection.json`; gitignored, rewritten on every refresh),
written by `pnpm qbo:auth` and read by the service and the sandbox tests.
Sandbox company: "Sandbox Company US 28a6". Machine-specific scratch files go in a gitignored `local/` directory.

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
- Deterministic tests use a fake QBO client; a separate sandbox run (`pnpm test:sandbox`) hits the real QBO sandbox.

### Git

- Conventional commits: `type(scope): description` (scope optional), types `feat | fix |
  docs | refactor | test | chore | style | perf`; imperative, subject under ~70 chars.
- **No AI signatures** (no `Co-Authored-By`, no "Generated with" footers).
- **Commit only when the user asks.** When a larger piece of work is done, propose a
  commit (summary + message) instead of making it.
- Run the check gate before committing (once it exists).

### Docs

- This file is the root index: high-level picture and pointers. A new fact earns a
  pointer, not a paragraph. `README.md` is the entry point for a reader of the repo.
- References point downward only; every doc reads correctly on its own.
- Specs state facts, not recommendations: `qbo-spec.md` describes QBO; what it means for
  us goes in `sync-notes.md` / `docs/design-details.md`.
- Durable docs describe the current state, not history (history is in git and the
  `docs/decision-log.md`). No volatile values; no self-referential links.

## Keeping this file current

Update this file in the same commit as any change to structure, commands, conventions or
sources of truth, and bump `last-updated`. After larger changes, run the `update-claude`
skill to reconcile it with the repo.
