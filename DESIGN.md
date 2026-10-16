# Design

Decisions for the two-way invoice sync, with the reasoning and the alternatives considered.
Requirements: `TASK.md`. Progress: `PROGRESS.md`.

## 1. System overview

Three running apps:

- **invoicing-service** - our internal invoicing system: customers, invoices, payments.
  Exposes an HTTP API and sends change webhooks. Has its own database.
- **qbo-sync-service** - syncs invoicing-service with QuickBooks Online (QBO). Receives
  webhooks from both sides, fetches current state, applies changes to the other side,
  keeps links between records and an audit log. Has its own database.
- **console** - a React UI for operating and demoing the system: invoicing pages (talk to
  invoicing-service) and sync pages such as audit log and conflicts (talk to
  qbo-sync-service).

```
                    ┌──────────────────────┐
                    │       console        │
                    └──────────────────────┘
                     │ HTTP             │ HTTP (audit, conflicts)
                     ▼                  ▼
  ┌───────────────────┐  webhooks  ┌──────────────────┐  webhooks  ┌───────┐
  │ invoicing-service │ ─────────► │ qbo-sync-service │ ◄───────── │  QBO  │
  │   (db: invoicing) │ ◄───────── │  (db: qbo_sync)  │ ─────────► │       │
  └───────────────────┘ API calls  └──────────────────┘ API calls  └───────┘
```

**Decision: the sync service is a separate process with its own database.** It talks to
invoicing-service only through its API and webhooks, exactly as it talks to QBO.

- Why: the task assumes two independent systems with APIs and webhook-like notifications,
  where payloads may be incomplete and calls may fail or time out. Running the sync inside
  invoicing-service, or letting it read invoicing-service's tables, would bypass exactly
  those problems. As a separate process, both sides are treated the same way, and failure
  cases (slow, down, duplicate delivery) can be tested on both.
- Alternative considered: one process, sync as a module calling the invoicing code
  directly. Simpler, but unrealistic and it hides the integration problems the task is
  about.
- Cost: more moving parts locally (two services, two databases). Kept manageable with
  Docker Compose: one Postgres container, two databases (`invoicing`, `qbo_sync`), so
  neither app can read the other's tables.

**Decision: qbo-sync-service runs as one process with two roles** - an HTTP server
(webhook receivers, read API for the console) and a background worker (sync jobs).

- Why: enough for this scope; one thing to run and debug.
- Alternative: separate webhook receiver and worker processes, so they scale and fail
  independently. The design keeps them decoupled through the database (received events
  are stored first, processed later), so splitting them later is a deployment change, not
  a rewrite.

## 2. Repository structure

A monorepo with pnpm workspaces:

```
apps/
  invoicing-service/      internal invoicing system (Fastify, Postgres via Kysely)
  qbo-sync-service/       sync with QBO (Fastify, Postgres via Kysely, worker, QBO client)
  console/                React + Vite UI: invoicing pages + sync activity
packages/
  invoicing-contract/     types + validation for the invoicing-service API,
                          shared by invoicing-service, qbo-sync-service and console
docker-compose.yml        Postgres (databases: invoicing, qbo_sync)
TASK.md  DESIGN.md  PROGRESS.md  README.md
```

**Decision: one UI (`console`) for both services.**

- Why: one place to click through the demo; an edit and its sync result can be shown side
  by side. Less UI work, which goes into the sync instead.
- Alternative: each service owns its UI (`invoicing-service-console`,
  `qbo-sync-service-console`). Closer to how separate products would ship, but doubles
  the UI work for no gain in what the task evaluates.

**Decision: share only what is actually shared.** The only shared package is
`invoicing-contract` (the invoicing-service API is used by three apps). The QBO client
lives inside qbo-sync-service, its only user. Database code is never shared between apps.

**Naming:** our system is "invoicing", QuickBooks is "QBO". We avoid "internal" /
"external", which only make sense from one side; the two sides stay symmetric in code
and docs.

## 3. Stack

TypeScript on Node (Fastify), PostgreSQL via Kysely, React + Vite, Vitest, Docker Compose,
pnpm workspaces.

- Why: matches the company's stack (TS / React / Node / SQL). Kysely keeps SQL visible and
  typed rather than hidden behind an ORM, which suits a task that evaluates data modeling.

## Open

- invoicing-service data model (customers, invoices, line items, payments; versioning and
  change notifications).
- Sync design: event intake, idempotency, conflict policy, delete vs void, payments,
  initial linkage, failure handling, accounts / GL.
