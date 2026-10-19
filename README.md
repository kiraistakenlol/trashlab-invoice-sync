# Two-Way Invoice Sync

A service that keeps invoices, payments, customers, items and income accounts in sync
between an invoicing system and QuickBooks Online (QBO), against the real QBO sandbox. It
reconciles the current state of both sides, writes changes idempotently, and flags
conflicts for a person instead of guessing.

## What to read

| Read | When |
|---|---|
| [`docs/design-writeup.md`](docs/design-writeup.md) | First: the components, the key decisions and their trade-offs |
| [`test/SCENARIOS.md`](test/SCENARIOS.md) | To see which edge cases are handled and how, as Given / When / Then; every one has a test |
| [`docs/design-details.md`](docs/design-details.md) | For the full detail behind a decision: every rule, the data model, the known limits |
| [`docs/invoicing-api-contract.md`](docs/invoicing-api-contract.md) | For the contract assumed for the invoicing system |
| [`qbo-playground/qbo-spec.md`](qbo-playground/qbo-spec.md) | For QBO's behaviour as verified against the sandbox, which the design and the fake QBO rely on |
| [`docs/how-it-was-built.md`](docs/how-it-was-built.md) | For how the work went, step by step, and why in that order |
| [`docs/assignment.md`](docs/assignment.md) | The assignment, verbatim |
| [`docs/decision-log.md`](docs/decision-log.md) | The dated decision log |

## Run it locally

Prerequisites: Node 24 (`.nvmrc`), pnpm 10, Docker.

```bash
pnpm install
cp .env.example .env     # fill in QBO_CLIENT_ID and QBO_CLIENT_SECRET from your Intuit app
pnpm qbo:auth            # open the printed URL and connect a sandbox company
docker compose up -d     # Postgres for the service
pnpm db:reset            # create the schema
pnpm invoicing:dev       # terminal 1: the invoicing system, in memory, on :4000
pnpm dev                 # terminal 2: the sync service on :3000
pnpm demo                # terminal 3: the walk-through
```

Three processes, three roles:

| Process | Role |
|---|---|
| `pnpm invoicing:dev` | **The invoicing system.** The system is assumed, so this serves an in-memory implementation of [its contract](docs/invoicing-api-contract.md) (the same code the tests use, there with failures armed). It sends a webhook to the sync on every change. |
| `pnpm dev` | **The sync.** The only process that moves data: takes webhooks, polls both systems, reads each changed record on both sides and writes the difference. |
| `pnpm demo` | **The people.** A script ([`demo/run.ts`](demo/run.ts)) that edits invoicing through its API and QBO through the QBO API, as a user of each would, then waits until the sync has carried the change to the other side. It never calls the sync's code; of the sync it uses only the HTTP API (issues, audit). |

What `pnpm demo` does, step by step:

1. Creates an invoice in invoicing → waits for it in QBO.
2. Edits its memo in QBO → waits for the memo in invoicing.
3. Records a payment in invoicing → waits for the QBO balance to drop.
4. Edits the memo on both sides → waits for the sync to open a conflict instead of choosing.
5. Resolves the conflict through `PATCH /issues/:id` → waits for the chosen memo in QBO.
6. Prints the audit trail of the pair.

Its records stay in the sandbox, so they can be checked in the QBO web UI.

- **How QBO changes arrive.** QBO sends webhooks only to a public URL, so locally the sync
  finds QBO changes by CDC polling every `POLL_INTERVAL_MS` (5 s in `.env.example`). For live
  QBO webhooks, tunnel `/webhooks/qbo` (for example with ngrok), register the URL in the
  Intuit app and set `QBO_WEBHOOK_VERIFIER_TOKEN`; without the token the route is off.
- **Restarting.** The invoicing system forgets everything when it stops: run `pnpm db:reset`
  before starting it again.
- **Editing by hand.** Any change made through the invoicing API (`curl` with the bearer token
  from `.env`) or in the QBO web UI is synced the same way.

## Tests

```bash
pnpm test                # offline, about a minute; needs Docker for Postgres
pnpm test:sandbox        # against the real QBO sandbox, about 15 minutes; needs `pnpm qbo:auth`
```

| Kind | Where | What it proves |
|---|---|---|
| Scenarios | `test/scenarios/` | Every case in [`test/SCENARIOS.md`](test/SCENARIOS.md) works: the real sync and a real Postgres against a fake invoicing system and a fake QBO, with duplicated, reordered and lost notifications, timeouts after a write, and a controlled clock |
| ★ scenarios on the sandbox | `test/scenarios/sandbox.test.ts` | The same ★ scenarios pass against the real QBO sandbox, including the General Ledger postings |
| QBO contract | `test/qbo-contract/` | The fake QBO behaves like the real one: one set of checks runs against both |
| Invariants | `test/invariants/` | Random edits on both sides, lossy delivery and injected failures always end converged or flagged, with no duplicates (property-based, fast-check) |
| Unit | `test/unit/` | What scenarios can't reach easily: queue races, lease fencing, poll cursors, diff, mappers |

## Assumptions

- **The invoicing system exists and is not part of this repo.** Its API, webhooks and
  events feed are assumed as described in [`docs/invoicing-api-contract.md`](docs/invoicing-api-contract.md); tests
  run against an in-memory fake of it.
- **One currency.** QBO records in another currency are flagged, not imported.
- **QBO owns sales tax.** Tax is imported into invoicing as an amount and never written to
  QBO.
- **Only income accounts are synced.** General ledger postings are derived by QBO from
  invoices and payments; manual journal entries are out of scope.
- **One service instance per QBO company**, so QBO tokens are kept in a local file.

## How it was built

Built together with Claude Code, Anthropic's coding agent. I set the direction and made
the design decisions: each was discussed and agreed before any code was written
([`docs/decision-log.md`](docs/decision-log.md)), and the QBO behaviour the design relies
on was verified against the sandbox first
([`qbo-playground/qbo-spec.md`](qbo-playground/qbo-spec.md)). Claude Code wrote most of the
code, tests and docs, working to the project rules in [`CLAUDE.md`](CLAUDE.md), which stays
in the repo as part of the record. [`docs/how-it-was-built.md`](docs/how-it-was-built.md)
describes the order of the work.
