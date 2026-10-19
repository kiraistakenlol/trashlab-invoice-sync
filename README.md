# Two-Way Invoice Sync

A service that keeps invoices, payments, customers, items and income accounts in sync
between an invoicing system and QuickBooks Online (QBO), and works against the real QBO
sandbox.

- **What it does:** it reads changes from both sides, reconciles each pair of records
  against the last state both sides agreed on, writes the result through each side's API,
  and flags whatever it can't decide (conflicts, unsupported data, ambiguous matches)
  instead of guessing.
- **How it was tested:** every scenario in [`test/SCENARIOS.md`](test/SCENARIOS.md) has a
  test. The ★ scenarios also run end to end against the QBO sandbox.
- **Why it is built this way:** [`WRITEUP.md`](WRITEUP.md) gives the decisions and
  trade-offs, and [`DESIGN.md`](DESIGN.md) has the full detail.
- **How the work went:** [`APPROACH.md`](APPROACH.md) lists the steps in order, and why
  each came where it did.

## Quick start

Prerequisites: Node ^22.15 or ≥ 23.8 (`.nvmrc` says 24), pnpm 10, and Docker.

```bash
pnpm install
cp .env.example .env               # fill in the QBO_* values (see "Connect QBO")
docker compose up -d               # Postgres for the service
pnpm db:reset                      # create the database from db/baseline.sql
pnpm dev                           # service + worker + pollers; pretty logs, also in logs/sync.log
curl localhost:3000/health
```

The invoicing system is not part of this repo (see Assumptions), so `INVOICING_API_URL`
points at nothing by default. The service still starts, answers webhooks and serves its
API. Calls to the invoicing system fail, and those jobs are logged and retried. The full
sync can be seen in the scenario tests, which run it against an in-memory invoicing system
and either a fake QBO or the real sandbox.

### Connect QBO

1. Create an app at developer.intuit.com. Under Development keys, copy the client id and
   secret into `QBO_CLIENT_ID` and `QBO_CLIENT_SECRET`.
2. Add `QBO_REDIRECT_URI` (default `http://localhost:3000/callback`) to the app's
   redirect URIs.
3. Copy the webhook verifier token into `QBO_WEBHOOK_VERIFIER_TOKEN`.
4. Run `pnpm qbo:auth`, open the URL it prints and approve the sandbox company. The realm
   id and tokens go to `QBO_CONNECTION_FILE`, which is gitignored and refreshed
   automatically.

`pnpm qbo:auth` listens on port 3000, the service's default port, so stop the service
while you run it.

## Tests

```bash
pnpm test             # offline: unit, scenarios, invariants, QBO contract vs the fake
pnpm test:sandbox     # against the real QBO sandbox (needs `pnpm qbo:auth`); ~15 min
pnpm check            # format + lint + typecheck + offline tests
```

| Kind | Where | What it proves |
|---|---|---|
| Scenarios | `test/scenarios/` | The sync does what `test/SCENARIOS.md` asks (Given / When / Then). Each test uses the real sync and its Postgres, with both systems faked. |
| ★ scenarios on the sandbox | `test/scenarios/star.ts`, `sandbox.test.ts` | The same suite against real QBO, plus the General Ledger postings (G2). |
| Invariants | `test/invariants/` | Property-based (fast-check) runs of random edits on both sides, with duplicated, reversed or dropped deliveries and failures injected. Afterwards the pairs converge or are flagged, there are no duplicates, and a replay writes nothing. |
| QBO contract | `test/qbo-contract/` | One set of QBO behaviour checks, run against both the fake and the sandbox, so the fake can't drift from real QBO. |
| Unit | `test/unit/` | The parts scenarios can't easily reach: queue races, lease fencing, poll cursors, diff, mappers, error classes. |

Run the sandbox suite with the machine awake (`caffeinate -i pnpm test:sandbox` on
macOS). It uses a unique name prefix per run and deletes or deactivates everything it
creates. The sandbox company is shared and can't be reset.

## Operating it

| Endpoint | Purpose |
|---|---|
| `POST /webhooks/qbo` | Intuit webhooks. The `intuit-signature` is verified, and only ids are taken from the payload. |
| `POST /webhooks/invoicing` | Change notifications from the invoicing system. |
| `GET /audit?system=&entityType=&entityId=` | A record's history: what changed, what the sync did, whether it succeeded. |
| `GET /issues?open=true` | What the sync flagged for a person. |
| `PATCH /issues/:id` `{ "resolution": "invoicing" \| "qbo" }` | Resolve a conflict by picking a side. The sync then writes it through the normal path. |
| `GET /jobs?status=failed` | Jobs that ran out of retries, with their last error. |
| `PATCH /jobs/:id` `{ "status": "pending" }` | Retry a failed job. |
| `GET /links/:id` | One linked pair and its snapshot. |

`pnpm sync:reconcile` enqueues every record on both sides once, for records that existed
before the sync was connected.

## Assumptions

- **The invoicing system is assumed, not built.** [`docs/INVOICING.md`](docs/INVOICING.md)
  is its contract:
  - a REST API with optimistic locking (`version`) and idempotent creates
    (`Idempotency-Key`);
  - best-effort webhooks plus an ordered events feed;
  - soft deletes, and voids that are final.

  Its data model is close to QBO's, so records map one to one. In tests, an in-memory fake
  implements exactly this contract, including its failure modes.
- **Single currency.** The sandbox has multicurrency off. QBO invoices in another currency,
  or with inventory items, text-only lines or discount lines, are flagged rather than
  imported.
- **Sales tax belongs to QBO.** It is imported into invoicing as an amount and never
  written to QBO. An invoice that carries tax and is created in invoicing is flagged
  rather than created in QBO.
- **Conflicts are never resolved automatically.**
  - A conflict is the same field changed differently on both sides, or a delete or void
    against an edit.
  - A conflict parks the pair until both sides agree or an operator picks a side.
  - Edits to different fields merge.
- **Unlinked records are matched before anything is created:**
  - invoices by number, customer and total;
  - customers, items and accounts by name.

  Anything ambiguous is flagged.
- **Only QBO Income accounts are synced.** General ledger postings are derived by QBO from
  invoices and payments. Manual journal entries are out of scope.
- **The service runs as one process with one QBO connection**, so the QBO token store is
  a file (`QBO_CONNECTION_FILE`). Several instances would need a database token store; the
  interface for it is already pluggable.

Known limits are listed at the end of [`DESIGN.md`](DESIGN.md) §5.

## Repository map

```
src/            the sync service
  qbo/          QBO client: OAuth, token refresh, requests, typed entity API
  invoicing/    invoicing contract types and HTTP client
  store/        repositories: links, jobs, issues, audit log, poll cursors
  sync/         intake, polling, worker, reconcile engine, conflict resolution, mappers
    specs/      per-entity rules (catalogue, invoice, payment)
  http/         webhooks, health, read and operator API
  cli/          db:reset, sync:reconcile
db/baseline.sql the service's schema
test/           scenarios, invariants, QBO contract, fakes, harness, unit
docs/           the assumed invoicing contract
qbo-playground/ scripts used to explore the QBO sandbox, and the verified QBO behaviour
                (qbo-spec.md) the fake is built from
```

[`TASK.md`](TASK.md) is the assignment. [`PROGRESS.md`](PROGRESS.md) is the decision log.
[`CLAUDE.md`](CLAUDE.md) holds the conventions the code follows.
