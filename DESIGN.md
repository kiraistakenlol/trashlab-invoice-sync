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

## 4. Testing

What the sync must do is a scenario list, `test/SCENARIOS.md` (Given / When / Then,
`core` built first, `extra` after). Each scenario is a Vitest test; no Cucumber.

| Layer | What is real | What is faked | Runs in |
|---|---|---|---|
| Integration | the sync, its Postgres | invoicing, QBO | `pnpm test` |
| Invariants (property-based, `fast-check`) | same | same, with random delivery and failures | `pnpm test` |
| QBO contract | - | - | against the fake in `pnpm test`, the sandbox in `pnpm test:e2e` |
| e2e (scenarios marked ★) | the sync, its Postgres, QBO sandbox | invoicing | `pnpm test:e2e` |

**Decision: the fake QBO reproduces only what the scenarios rely on**, all verified in
the sandbox (`qbo-playground/qbo-spec.md`): `SyncToken` and stale-token errors,
`requestid` replay, void as a zeroed invoice with a "Voided -" note, delete ignoring
`SyncToken`, payments unapplied on void / delete / reduction, CDC with delete stubs,
non-unique `DocNumber`, id-only webhooks. It adds controls the real QBO lacks: hold,
duplicate, reorder or drop notifications; timeout after a write; 5xx, 429, 401. Not
reproduced: automatic credit application, tax and currency math, rate limiting. The
contract tests run the same checks against the fake and the sandbox, so the fake can't
drift from the real behaviour.

**Decision: a fresh database per test**, created from a template database that has
`db/baseline.sql` applied (one Testcontainers Postgres per run). Tests can't see each
other's data and test files run in parallel. Postgres is real because the sync's
guarantees rest on it: transactions, unique constraints, row locks.

**Decision: tests drive time and delivery; no sleeps.** Each test builds a world: the
real sync wired to both fakes, an injectable clock and its database. The test decides
when notifications are delivered (through the real webhook route, via Fastify `inject`),
runs the worker until the queue is empty (`drain`), triggers one polling cycle, and
advances the clock for backoff. This requires the sync to take all dependencies as
arguments and to have a worker that can drain and stop.

**Decision: preconditions are built through the sync itself.** "Given a linked invoice"
creates it in the fake invoicing system and runs the sync, so the starting state is what
the real code produces. Direct seeding is used only for states the sync can't produce,
such as records that existed on both sides before it was connected.

**Decision: ★ scenarios are written once and run in both worlds.** Assertions use only
what the fake and the sandbox both offer (e.g. "no second write" is an unchanged
`SyncToken`). In e2e:
- The test plays a person editing QBO through its own API client.
- QBO changes are picked up by polling (CDC) with a bounded wait, since live webhooks
  need a public URL and arrive with unpredictable delay. Webhook intake is covered by
  integration tests on recorded Intuit payloads.
- The shared sandbox can't be reset, so every run uses a unique name prefix, runs
  sequentially, and cleans up after itself (deletes invoices and payments; deactivates
  customers and items, which QBO can't delete).
- e2e needs the network and a QBO connection, so it stays out of `pnpm check`.

## Open

- Sync design: event intake, idempotency, conflict policy, delete vs void, payments,
  initial linkage, failure handling, accounts / GL.
