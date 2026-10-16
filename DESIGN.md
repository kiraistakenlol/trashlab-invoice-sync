# Design

Decisions for the two-way invoice sync, with the reasoning and the alternatives considered.
Requirements: `TASK.md`. Progress: `PROGRESS.md`.

## 1. System overview

The sync connects two systems: "our" invoicing system and QuickBooks Online (QBO).

- **The sync service** (this repo) - syncs the invoicing system with QBO. Receives change
  notifications from both sides, fetches current state, applies changes to the other side,
  keeps links between records and an audit log. Has its own database.
- **The invoicing system** - assumed, not built. The sync talks to it only through the
  contract in `docs/INVOICING.md` (API + change notifications); in tests an in-memory
  fake plays it.

```
  ┌───────────────────┐  webhooks  ┌──────────────────┐  webhooks  ┌───────┐
  │ invoicing system  │ ─────────► │   sync service   │ ◄───────── │  QBO  │
  │ (assumed; a fake  │ ◄───────── │  (own Postgres)  │ ─────────► │       │
  │  in tests)        │ API calls  └──────────────────┘ API calls  └───────┘
  └───────────────────┘
```

**Decision: the invoicing system is assumed and simulated, not built.**

- Why: the task assumes an existing internal system with an API and webhook-like
  notifications and evaluates the sync - idempotency, conflicts, reliability under
  partial failure, tests. Building a second service would spend effort outside that.
  An in-memory fake gives full control over the integration mess on that side
  (duplicate, delayed, reordered or lost events, timeouts after a write, stale versions),
  so edge cases are tested deterministically.
- What the sync may assume is written down as a contract (`docs/INVOICING.md`), close to
  QBO's model so records map one-to-one; the fake implements exactly that contract.
- Alternatives considered: a real invoicing service with its own database and UI (best
  for a click-through demo, but a large share of the work); the invoicing data as tables
  inside the sync service (simple, but it bypasses the API boundary and hides half of the
  problem the task is about).
- Cost: no hand-editable invoicing side at runtime. The demo runs scripted scenarios
  against the real QBO sandbox instead.

**Decision: the sync service is a separate process with its own database**, talking to
both systems only through their APIs and notifications.

- Why: treats both sides the same way, so failure cases (slow, down, duplicate delivery)
  apply to both and are tested on both.

**Decision: the sync service runs as one process with two roles** - an HTTP server
(webhook receivers, a read API for links, audit log and conflicts) and a background
worker (sync jobs).

- Why: enough for this scope; one thing to run and debug.
- Alternative: separate webhook receiver and worker processes, so they scale and fail
  independently. The design keeps them decoupled through the database (received events
  are stored first, processed later), so splitting them later is a deployment change, not
  a rewrite.

## 2. Repository structure

One package - the repo is the sync service:

```
src/                      the sync service
  qbo/                    QBO transport: OAuth, token refresh, requests (minor version,
                          requestid, timeout), raw responses; token storage pluggable
test/                     scenario tests, fakes (invoicing system, QBO), e2e
docs/INVOICING.md         the assumed invoicing contract
qbo-playground/           scripts to explore and verify QBO sandbox API behaviour, and
                          the findings (qbo-spec.md, sync-notes.md)
docker-compose.yml        Postgres
TASK.md  DESIGN.md  PROGRESS.md  README.md
```

**Decision: a single package, no workspaces.** With one service, workspaces and shared
packages add build and navigation overhead without a second consumer. The QBO client is
a module (`src/qbo`) that knows only QBO; the playground scripts import it directly, so
what the exploration verified is the code the sync runs.

**Decision: no UI.** The sync's state (links, audit log, conflicts) is exposed through a
small read API; the demo shows it through scenario output alongside the QBO web UI. A UI
would take effort from the sync and tests for little evaluated value.

**Naming:** our system is "invoicing", QuickBooks is "QBO". We avoid "internal" /
"external", which only make sense from one side; the two sides stay symmetric in code
and docs.

## 3. Stack

TypeScript on Node (Fastify), PostgreSQL via Kysely, Vitest, Docker Compose, pnpm.

- Why: matches the company's stack (TS / Node / SQL). Kysely keeps SQL visible and typed
  rather than hidden behind an ORM, which suits a task that evaluates data modeling.

## Open

- Tests: the fake invoicing system, the fake QBO, e2e against the sandbox, scenario list.
- Sync design: event intake, idempotency, conflict policy, delete vs void, payments,
  initial linkage, failure handling, accounts / GL.
