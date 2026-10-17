# Foundation Implementation Plan (1 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tooling, a per-test Postgres, the in-memory fakes of both systems, and QBO
contract tests that run against the fake (`pnpm test`) and the real sandbox
(`pnpm test:e2e`). No sync logic yet.

**Architecture:** The fake QBO implements the existing transport interface `QboClient`
(`src/qbo/client.ts`), so the sync's QBO adapter (plan 2) runs unchanged against the
fake and the sandbox, and one contract suite checks both. The invoicing system has no
real implementation: `src/invoicing/` defines its typed client interface from
`docs/INVOICING.md`, and the fake implements that interface directly. Each test gets a
fresh database cloned from a template that has `db/baseline.sql` applied.

**Tech Stack:** TypeScript (Node ≥ 22, ESM, NodeNext), pnpm, Vitest 3 (projects),
Testcontainers (`@testcontainers/postgresql`), Kysely + `pg`, `big.js`, Prettier,
ESLint 9 + typescript-eslint.

**Spec:** `DESIGN.md` (sections 4 Testing, 5 Sync), `docs/INVOICING.md`,
`qbo-playground/qbo-spec.md` (verified QBO behaviour; section numbers below refer to it),
`db/baseline.sql`, `test/SCENARIOS.md`, `CLAUDE.md` (conventions).

**Later plans:** 2 - sync core (intake, queue, worker, links, reconciliation, core
scenarios); 3 - e2e scenarios, invariants, extra scenarios, README and write-up.

## Global Constraints

- Prettier: no semicolons, single quotes, 2-space indent, trailing commas `es5`, 100-col width, LF.
- TypeScript `strict` plus `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`; `import type` for type-only imports; files `kebab-case.ts`.
- Money is never a JS `number`: decimal strings with 2 places on the wire (`"150.00"`), arithmetic only through `src/money.ts`.
- Enums are TS string unions (no magic strings); stored as `text` in Postgres.
- Timestamps UTC, serialized with `Z`.
- No `console.log` under `src/` (lint rule); tests and `qbo-playground` may print.
- `src/` never imports from `test/` or `qbo-playground/`; `src/qbo` knows nothing about the sync.
- Minimal comments: one-line module header; inline only for the non-obvious; never reference other files or docs.
- Conventional commits, no AI signatures (`Co-Authored-By`, "Generated with"); commit only the files the task lists. `pnpm check` must pass before each commit (from Task 1 on).
- Never print or commit secrets; `qbo-playground/.qbo-connection.json` and `.env` stay gitignored.

## Review Focus

1. Decimal math in the fakes - totals, balances and 8 % tax must match QBO to the cent (15.00 → tax 1.20). Pinned in Task 2 and contract test `computes 8 % tax ...` (Task 10).
2. Template-database cloning under parallel test files - `CREATE DATABASE ... TEMPLATE` fails while anything is connected to the template. Pinned in Task 3 (`two fresh databases in parallel`).
3. "Timeout after write" must look exactly like the real client's timeout (a `DOMException` named `TimeoutError`) *and* have applied the write. Pinned in Tasks 6 and 10.
4. `requestid` replay is per entity type and ignores the body (qbo-spec 7) - an easy thing for a fake to get "more correct" than QBO. Pinned in contract tests (Task 9).
5. CDC `changedSince` is exclusive with whole-second `LastUpdatedTime` (qbo-spec 10) - an off-by-one here hides lost changes. Pinned in contract test `CDC changedSince is exclusive` (Task 10).

## File Structure

```
package.json, tsconfig.json          modified: deps, scripts, strict flags, include test/
.prettierrc.json, .prettierignore    Prettier config
eslint.config.js                     ESLint flat config
vitest.config.ts                     projects: "default" (everything but test/e2e), "e2e"
src/money.ts                         decimal money helpers
src/db/database.ts                   Kysely table types for db/baseline.sql
src/db/create-db.ts                  createDb(connectionString)
src/invoicing/types.ts               invoicing entities, inputs, events (docs/INVOICING.md)
src/invoicing/client.ts              InvoicingClient interface
src/invoicing/errors.ts              InvoicingApiError
src/qbo/entities.ts                  QBO entity and envelope types (subset the sync uses)
src/qbo/webhooks.ts                  webhook payload type, signature compute / verify
test/harness/global-setup.ts         Testcontainers Postgres + template database
test/harness/fresh-db.ts             freshDb(): a new database cloned from the template
test/harness/eventually.ts           eventually(): bounded wait for sandbox reads
test/fakes/fake-invoicing.ts         FakeInvoicing implements InvoicingClient + controls
test/fakes/fake-qbo.ts               FakeQbo implements QboClient + controls
test/fakes/failures.ts               shared failure kinds, timeoutError()
test/contract/qbo-contract.ts        qboContract(): the shared QBO behaviour suite
test/contract/qbo-fake.test.ts       runs the suite against FakeQbo
test/e2e/qbo-sandbox.test.ts         runs the suite against the sandbox
test/e2e/sandbox-client.ts           sandbox QboClient from the playground wiring
test/unit/                           unit tests for src/, mirroring its paths
```

Unit tests for `src/` live in `test/unit/<same path>.test.ts`; fake tests in
`test/fakes/*.test.ts`.

---

### Task 1: Tooling and the check gate

**Files:**
- Modify: `package.json`, `tsconfig.json`, `CLAUDE.md` (Development: commands), all existing `.ts` files (reformat only)
- Create: `.prettierrc.json`, `.prettierignore`, `eslint.config.js`, `vitest.config.ts`, `test/unit/smoke.test.ts`

**Interfaces:**
- Produces: scripts `format`, `format:check`, `lint`, `typecheck`, `test`, `test:e2e`, `check`; Vitest projects `default` and `e2e`.

- [ ] **Step 1: Install dev dependencies**

Run: `pnpm add -D vitest @vitest/coverage-v8 prettier eslint @eslint/js typescript-eslint globals @testcontainers/postgresql testcontainers`
and `pnpm add kysely pg big.js` and `pnpm add -D @types/pg @types/big.js`.
Expected: lockfile updated, no peer warnings that fail install.

- [ ] **Step 2: Configs**

- `.prettierrc.json`: `{ "semi": false, "singleQuote": true, "tabWidth": 2, "trailingComma": "es5", "printWidth": 100, "endOfLine": "lf" }`. `.prettierignore`: `pnpm-lock.yaml`, `local/`, `*.md`.
- `tsconfig.json`: add `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`, `"types": ["node"]`; `include`: `["src", "test", "qbo-playground/src", "*.config.ts"]`.
- `eslint.config.js`: `@eslint/js` recommended + `typescript-eslint` recommended; `no-console: error` for `src/**`; `@typescript-eslint/no-unused-vars` with `argsIgnorePattern/varsIgnorePattern: '^_'`; ignore `node_modules`, `local`.
- `vitest.config.ts`: `test.projects`:
  - `default`: `include: ['test/**/*.test.ts']`, `exclude: ['test/e2e/**']`, `globalSetup: ['test/harness/global-setup.ts']` (added in Task 3 - leave the key out until then).
  - `e2e`: `include: ['test/e2e/**/*.test.ts']`, `fileParallelism: false`, `testTimeout: 60_000`.
- Scripts: `"format": "prettier --write ."`, `"format:check": "prettier --check ."`, `"lint": "eslint ."`, `"test": "vitest run --project default"`, `"test:e2e": "vitest run --project e2e"`, `"check": "pnpm format:check && pnpm lint && pnpm typecheck && pnpm test"`.

- [ ] **Step 3: Smoke test**

`test/unit/smoke.test.ts`: `it('runs', () => expect(1 + 1).toBe(2))`. (Deleted in Task 2.)

- [ ] **Step 4: Reformat and fix lint in existing code**

Run: `pnpm format && pnpm lint`. Fix lint errors in `src/qbo` and `qbo-playground/src` without changing behaviour (playground keeps its `console.log`).

- [ ] **Step 5: Verify the gate**

Run: `pnpm check`
Expected: all four stages pass; Vitest reports 1 passed.

- [ ] **Step 6: Update `CLAUDE.md` Development section** - list the scripts above as existing (remove them from "Planned", keep `dev` planned), bump `last-updated` if present.

- [ ] **Step 7: Commit** (two commits: the reformat alone, then the tooling)

```bash
git add src qbo-playground/src && git commit -m "style: format with prettier"
git add package.json pnpm-lock.yaml tsconfig.json .prettierrc.json .prettierignore eslint.config.js vitest.config.ts test/unit/smoke.test.ts CLAUDE.md
git commit -m "chore: add prettier, eslint, vitest and the check gate"
```

---

### Task 2: Money

**Files:**
- Create: `src/money.ts`, `test/unit/money.test.ts`
- Delete: `test/unit/smoke.test.ts`

**Interfaces:**
- Produces (`src/money.ts`):
  - `type Money = string` (always 2 decimals)
  - `add(...xs: Money[]): Money` (no args → `'0.00'`)
  - `sub(a: Money, b: Money): Money`
  - `lineAmount(quantity: string, unitPrice: Money): Money | null` - exact product, or `null` when it has more than 2 decimals
  - `percentOf(amount: Money, rate: string): Money` - round half up to 2 decimals
  - `cmp(a: Money, b: Money): -1 | 0 | 1`, `isZero(a: Money): boolean`, `min(a: Money, b: Money): Money`
  - `toMoney(value: string | number): Money` - normalizes QBO amounts (QBO sends numbers) to 2 decimals; the only place a `number` is accepted

- [ ] **Step 1: Write the failing tests**

```ts
it('adds without float error', () => expect(add('0.10', '0.20')).toBe('0.30'))
it('adds nothing to zero', () => expect(add()).toBe('0.00'))
it('subtracts', () => expect(sub('100.00', '30.00')).toBe('70.00'))
it('multiplies exactly', () => expect(lineAmount('2', '50.00')).toBe('100.00'))
it('rejects a product with more than 2 decimals', () => expect(lineAmount('1.5', '0.01')).toBeNull())
it('takes 8 % of 15.00 as 1.20', () => expect(percentOf('15.00', '0.08')).toBe('1.20'))
it('rounds half up', () => expect(percentOf('10.05', '0.5')).toBe('5.03'))
it('normalizes a QBO number', () => expect(toMoney(108)).toBe('108.00'))
it('compares', () => { expect(cmp('9.99', '10.00')).toBe(-1); expect(isZero('0.00')).toBe(true) })
```

- [ ] **Step 2: Run to see them fail** - `pnpm vitest run test/unit/money.test.ts` → FAIL, module not found.
- [ ] **Step 3: Implement with `big.js`** (`Big.RM = 1`, round half up; `toFixed(2)` on output).
- [ ] **Step 4: Run to see them pass**, then `pnpm check`.
- [ ] **Step 5: Commit** - `feat: add decimal money helpers`.

---

### Task 3: Database types and the per-test database

**Files:**
- Create: `src/db/database.ts`, `src/db/create-db.ts`, `test/harness/global-setup.ts`, `test/harness/fresh-db.ts`, `test/harness/fresh-db.test.ts`
- Modify: `vitest.config.ts` (add `globalSetup` to the `default` project)

**Interfaces:**
- Produces:
  - `src/db/database.ts`: `interface Database { invoicing_qbo_links: InvoicingQboLinksTable; sync_jobs: SyncJobsTable; sync_issues: SyncIssuesTable; audit_log: AuditLogTable; poll_cursors: PollCursorsTable }` - one interface per table mirroring `db/baseline.sql` column by column (Kysely `Generated<>` for defaults, `ColumnType` where insert/select differ; `numeric` none; `jsonb` as `unknown`). Union types for text enums: `System = 'invoicing' | 'qbo'`, `EntityType = 'account' | 'item' | 'customer' | 'invoice' | 'payment'`, `JobStatus`, `IssueKind`, `IssueResolution`, `AuditAction` - exact values from the baseline `CHECK`s.
  - `src/db/create-db.ts`: `createDb(connectionString: string): Kysely<Database>` (pg `Pool`, `max` 5).
  - `test/harness/fresh-db.ts`: `freshDb(): Promise<{ db: Kysely<Database>; destroy(): Promise<void> }>`.
  - Global setup provides `inject('pgAdminUrl')` (URL to the `postgres` database) and the template name `sync_template`; declare the `ProvidedContext` type.

- [ ] **Step 1: Write the failing tests** (`test/harness/fresh-db.test.ts`)

```ts
it('has the baseline schema', async () => {
  const { db, destroy } = await freshDb()
  const tables = await sql<{ t: string }>`select tablename as t from pg_tables where schemaname = 'public' order by 1`.execute(db)
  expect(tables.rows.map((r) => r.t)).toEqual(['audit_log', 'invoicing_qbo_links', 'poll_cursors', 'sync_issues', 'sync_jobs'])
  await destroy()
})
it('isolates databases', async () => {
  const a = await freshDb(); const b = await freshDb()
  await a.db.insertInto('poll_cursors').values({ system: 'qbo', cursor: 'x' }).execute()
  expect(await b.db.selectFrom('poll_cursors').selectAll().execute()).toEqual([])
  await a.destroy(); await b.destroy()
})
it('creates two fresh databases in parallel', async () => {
  const [a, b] = await Promise.all([freshDb(), freshDb()])
  await Promise.all([a.destroy(), b.destroy()])
})
```

- [ ] **Step 2: Run to see them fail** - `pnpm test` → FAIL (no global setup / module).
- [ ] **Step 3: Implement**
  - Global setup: start `PostgreSqlContainer('postgres:17-alpine')`; with a `pg` client on the `postgres` database run `CREATE DATABASE sync_template`; connect to it, run `db/baseline.sql` (read from disk, one `query` call), **close that connection**; `provide('pgAdminUrl', …)`; teardown stops the container.
  - `freshDb`: name `t_<random hex 12>`; `CREATE DATABASE <name> TEMPLATE sync_template` through a short-lived admin client; return `createDb(url)`; `destroy` destroys the Kysely instance then `DROP DATABASE <name> WITH (FORCE)`.
- [ ] **Step 4: Run to see them pass**, then `pnpm check`.
- [ ] **Step 5: Commit** - `test: add a fresh database per test from a template`.

---

### Task 4: Invoicing contract types and the fake: catalogue and invoices

**Files:**
- Create: `src/invoicing/types.ts`, `src/invoicing/client.ts`, `src/invoicing/errors.ts`, `test/fakes/failures.ts`, `test/fakes/fake-invoicing.ts`, `test/fakes/fake-invoicing.test.ts`

**Interfaces:**
- Produces (`src/invoicing/types.ts`), fields exactly as `docs/INVOICING.md`, camelCase, timestamps ISO strings, dates `YYYY-MM-DD`, money `Money`:
  - `Account { id, name, version, deactivatedAt: string | null, createdAt, updatedAt }`
  - `Item { id, name, incomeAccountId, version, deactivatedAt, createdAt, updatedAt }`
  - `Customer { id, name, email: string | null, version, deactivatedAt, createdAt, updatedAt }`
  - `InvoiceLine { id, itemId, description: string | null, quantity: string, unitPrice: Money, amount: Money }` (position = array order)
  - `InvoiceStatus = 'open' | 'partly_paid' | 'paid' | 'void' | 'deleted'`
  - `Invoice { id, number, customerId, issueDate, dueDate, memo: string | null, lines: InvoiceLine[], tax: Money, total: Money, paid: Money, balance: Money, status: InvoiceStatus, version, voidedAt, deletedAt, createdAt, updatedAt }`
  - Inputs: `AccountInput { name }`, `ItemInput { name, incomeAccountId }`, `CustomerInput { name, email? }`, `InvoiceLineInput { id?, itemId, description?, quantity, unitPrice, amount }`, `InvoiceInput { number?, customerId, issueDate, dueDate, memo?, lines, tax? }`, `InvoiceReplace = Omit<InvoiceInput, 'number'>`; catalogue updates take `Partial<…Input> & { deactivated?: boolean }`.
- Produces (`src/invoicing/client.ts`): `interface InvoicingClient` with, for `account | item | customer`: `getX(id): Promise<X | null>`, `listXs(): Promise<X[]>`, `createX(input, idempotencyKey: string): Promise<X>`, `updateX(id, patch, version: number): Promise<X>`; invoices: `getInvoice(id)`, `listInvoices(filter?: { customerId?: string; number?: string }): Promise<Invoice[]>` (number compared ignoring case; deleted included), `createInvoice(input, idempotencyKey)`, `replaceInvoice(id, input: InvoiceReplace, version)`, `voidInvoice(id, version)`, `deleteInvoice(id, version)`. (Payments and events are added in Tasks 5-6.)
- Produces (`src/invoicing/errors.ts`): `class InvoicingApiError extends Error { constructor(readonly status: 404 | 409 | 422 | 503, readonly code: InvoicingErrorCode, message: string) }`, `InvoicingErrorCode = 'not_found' | 'version_conflict' | 'idempotency_mismatch' | 'number_taken' | 'rule_violation' | 'unavailable'`.
- Produces (`test/fakes/failures.ts`): `type Failure = 'timeout_before_write' | 'timeout_after_write' | 'unavailable'`; `timeoutError(): DOMException` (name `TimeoutError`, as `AbortSignal.timeout` produces).
- Produces (`test/fakes/fake-invoicing.ts`): `class FakeInvoicing implements InvoicingClient`, `constructor(opts?: { now?: () => Date })`.

Rules the fake enforces (each a test below): names unique ignoring case (`409 number_taken` is for invoice numbers; names use `422 rule_violation`); invoice `number` optional → generated `INV-0001`, `INV-0002` …; number unique ignoring case and ≤ 21 chars; each line `amount === lineAmount(quantity, unitPrice)`; at least one line; `total = add(...amounts, tax)`, `tax` default `'0.00'`; line ids kept for lines sent with an id, new ids for lines without; every write bumps `version`; a wrong `version` → `409 version_conflict`; void and delete of a void invoice → `422`; any write to a deleted record → `422`; `getInvoice` returns deleted invoices with `deletedAt` and `status: 'deleted'`; idempotency: same key + same body → the stored response, no second record; same key + different body → `409 idempotency_mismatch`.

- [ ] **Step 1: Write the failing tests** (`test/fakes/fake-invoicing.test.ts`, one `it` each):
  `generates invoice numbers`, `rejects a duplicate number ignoring case` (expect `InvoicingApiError` with `code: 'number_taken'`), `rejects a number over 21 characters`, `rejects a line whose amount is not quantity × unit price`, `derives total from lines plus tax` (lines 100.00 + 30.00, tax 1.20 → total 131.20, balance 131.20, status open), `keeps line ids across a replace` (replace with line 1 changed, line 2 dropped, a new line → ids `[l1, new]`, version 2), `rejects a stale version`, `void is final` (void → status void; replace and void again → 422), `delete is soft` (get returns `deletedAt` set, status deleted; replace → 422), `replays a create with the same idempotency key` (same id, one invoice in `listInvoices()`), `rejects the same key with a different body`, `filters by number ignoring case`, `rejects a duplicate customer name ignoring case`, `deactivates a customer` (`updateCustomer(id, { deactivated: true }, 1)` → `deactivatedAt` set).
- [ ] **Step 2: Run to see them fail.**
- [ ] **Step 3: Implement** types, interface, error class, failures module, and the fake (in-memory `Map`s; idempotency store `Map<key, { bodyJson, response }>` keyed globally; clock from `now`).
- [ ] **Step 4: Run to see them pass**, then `pnpm check`.
- [ ] **Step 5: Commit** - `test: add the invoicing contract types and a fake with invoices`.

---

### Task 5: Fake invoicing: payments and allocations

**Files:**
- Modify: `src/invoicing/types.ts`, `src/invoicing/client.ts`, `test/fakes/fake-invoicing.ts`, `test/fakes/fake-invoicing.test.ts`

**Interfaces:**
- Produces: `Allocation { invoiceId, amount: Money }`; `Payment { id, customerId, amount, date, allocations: Allocation[], unapplied: Money, version, deletedAt, createdAt, updatedAt }`; `PaymentInput { customerId, amount, date, allocations }`; client methods `getPayment`, `listPayments(filter?: { customerId?: string })`, `createPayment(input, idempotencyKey)`, `replacePayment(id, input: PaymentInput, version)`, `deletePayment(id, version)`.

Rules (contract "Payments and allocations"): `amount > 0`; allocations total ≤ amount; each allocated invoice belongs to the payment's customer and is not void or deleted; an invoice's allocations total ≤ its total; allocation changes bump the payment's version only; `paid`, `balance`, `status` of invoices derive from non-deleted payments; void / delete of an invoice with allocations → `422`; replacing an invoice with a total below its allocations → `422`; changing the customer of an invoice that has allocations → `422`. All violations `422 rule_violation`.

- [ ] **Step 1: Write the failing tests**: `partial payments add up` (100 paid 30, 50, 20 → balances 70, 20, 0; statuses partly_paid, partly_paid, paid), `one payment over two invoices` (100 → 60 / 40, unapplied 0.00), `keeps unallocated money as unapplied`, `rejects allocations above the payment amount`, `rejects an allocation to another customer's invoice`, `rejects over-allocating an invoice`, `rejects void and delete of an invoice with allocations`, `rejects reducing a total below what is allocated`, `deleting a payment restores the invoice balance`, `an allocation change bumps the payment version, not the invoice version`.
- [ ] **Step 2: Run to see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to see them pass**, then `pnpm check`.
- [ ] **Step 5: Commit** - `test: add payments and allocations to the fake invoicing system`.

---

### Task 6: Fake invoicing: events, webhooks and failures

**Files:**
- Modify: `src/invoicing/types.ts`, `src/invoicing/client.ts`, `test/fakes/fake-invoicing.ts`, `test/fakes/fake-invoicing.test.ts`

**Interfaces:**
- Produces:
  - `InvoicingEntityType = 'account' | 'item' | 'customer' | 'invoice' | 'payment'`; `InvoicingEventKind = 'created' | 'updated' | 'voided' | 'deleted'`; `InvoicingEvent { id: string; entityType; entityId; kind; version: number }`. Event ids sort in feed order (`evt_000001`, …).
  - Client: `listEvents(after: string | null, limit?: number): Promise<InvoicingEvent[]>` (default limit 100, ascending).
  - Fake controls:
    - `takeWebhooks(opts?: { duplicate?: boolean; reverse?: boolean; drop?: (e: InvoicingEvent) => boolean }): InvoicingEvent[]` - returns and clears the events not yet delivered; `duplicate` returns each twice, `reverse` newest first, `drop` removes matches (they stay in the feed).
    - `failNext(op: keyof InvoicingClient, failure: Failure): void` - the next call of `op` fails once: `timeout_before_write` throws `timeoutError()` with no change; `timeout_after_write` applies the write, records its event and idempotency entry, then throws `timeoutError()`; `unavailable` throws `InvoicingApiError(503, 'unavailable')` with no change.

- [ ] **Step 1: Write the failing tests**: `records one event per change in feed order` (create, replace, void → kinds created, updated, voided; versions 1, 2, 3), `pages the feed after a cursor`, `a replayed create records no second event`, `takeWebhooks returns each event once`, `takeWebhooks can duplicate, reverse and drop` (dropped events still in `listEvents`), `timeout after write applies the write` (`failNext('createInvoice', 'timeout_after_write')`; the call rejects with `name === 'TimeoutError'`; `listInvoices()` has 1; retry with the same key returns that invoice), `timeout before write changes nothing`, `unavailable throws 503 once`.
- [ ] **Step 2: Run to see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to see them pass**, then `pnpm check`.
- [ ] **Step 5: Commit** - `test: add events, webhooks and failure injection to the fake invoicing system`.

---

### Task 7: QBO entity types and webhook signatures

**Files:**
- Create: `src/qbo/entities.ts`, `src/qbo/webhooks.ts`, `test/unit/qbo/webhooks.test.ts`
- Modify: `src/qbo/index.ts` (export both)

**Interfaces:**
- Produces (`src/qbo/entities.ts`) - the subset of fields the sync reads or writes, names exactly as QBO's JSON (qbo-spec 5, 6, 8, 9, 11), amounts as `number` (QBO's wire type; convert with `toMoney`):
  - `QboRef { value: string; name?: string }`, `QboMetaData { CreateTime: string; LastUpdatedTime: string }`
  - `QboCustomer { Id, SyncToken, DisplayName, Active, MetaData }`
  - `QboAccount { Id, SyncToken, Name, AccountType, Active, MetaData }`
  - `QboItem { Id, SyncToken, Name, Type: 'Service' | 'Inventory' | 'NonInventory', IncomeAccountRef?: QboRef, Active, MetaData }`
  - `QboSalesLine { Id?, LineNum?, Amount, Description?, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: QboRef; Qty?: number; UnitPrice?: number; TaxCodeRef?: QboRef } }`; `QboOtherLine { Id?, Amount, Description?, DetailType: 'SubTotalLineDetail' | 'DescriptionOnly' | 'DiscountLineDetail' }`; `QboInvoiceLine = QboSalesLine | QboOtherLine`
  - `QboInvoice { Id, SyncToken, DocNumber?, CustomerRef, TxnDate, DueDate?, CustomerMemo?: { value: string }, PrivateNote?, CurrencyRef: QboRef, Line: QboInvoiceLine[], TxnTaxDetail?: { TxnTaxCodeRef?: QboRef; TotalTax: number }, TotalAmt, Balance, LinkedTxn: { TxnId: string; TxnType: string }[], MetaData }`
  - `QboPayment { Id, SyncToken, CustomerRef, TotalAmt, TxnDate, UnappliedAmt, PrivateNote?, DepositToAccountRef?: QboRef, Line: { Amount: number; LinkedTxn: { TxnId: string; TxnType: 'Invoice' }[] }[], MetaData }`
  - `QboDeletedStub { domain: 'QBO'; status: 'Deleted'; Id: string; MetaData?: { LastUpdatedTime: string } }`
  - `QboFault { Fault: { Error: { Message: string; Detail?: string; code: string; element?: string }[]; type: string }; time: string }`
  - `QboEntityName = 'Customer' | 'Account' | 'Item' | 'Invoice' | 'Payment'`
- Produces (`src/qbo/webhooks.ts`):
  - `QboWebhookEntity { name: string; id: string; operation: 'Create' | 'Update' | 'Delete' | 'Void' | 'Merge' | 'Emailed'; lastUpdated: string }`
  - `QboWebhookPayload { eventNotifications: { realmId: string; dataChangeEvent: { entities: QboWebhookEntity[] } }[] }`
  - `signQboWebhook(rawBody: string, verifierToken: string): string` - base64 HMAC-SHA256 (qbo-spec 14.2)
  - `verifyQboWebhook(rawBody: string, signature: string | undefined, verifierToken: string): boolean` - constant-time compare; `false` for a missing signature

- [ ] **Step 1: Write the failing tests**: `signs as base64 HMAC-SHA256 of the raw body` (compare with `createHmac('sha256', token).update(body).digest('base64')`), `verifies its own signature`, `rejects a signature over a different body`, `rejects a missing signature`.
- [ ] **Step 2: Run to see them fail.**
- [ ] **Step 3: Implement** with `node:crypto` (`timingSafeEqual` on equal-length buffers).
- [ ] **Step 4: Run to see them pass**, then `pnpm check`.
- [ ] **Step 5: Commit** - `feat(qbo): add entity types and webhook signatures`.

---

### Task 8: QBO contract suite and fake QBO: records, SyncToken, queries

**Files:**
- Create: `test/contract/qbo-contract.ts`, `test/contract/qbo-fake.test.ts`, `test/fakes/fake-qbo.ts`

**Interfaces:**
- Consumes: `QboClient`, `QboResponse` (`src/qbo/client.ts`); entity types (Task 7).
- Produces:
  - `qboContract(opts: { client: () => QboClient; prefix: string; settle: <T>(read: () => Promise<T>, ok: (v: T) => boolean) => Promise<T> }): void` - registers the suite with `describe`/`it`. `prefix` makes every created name and `DocNumber` unique to the run (DocNumber ≤ 21 chars: use a 6-char prefix). `settle` is `eventually` for the sandbox, a single read for the fake. The suite tracks what it creates and cleans up in `afterAll` (delete payments, then invoices; deactivate customers).
  - Suite helpers inside the module: `createCustomer(name)`, `createInvoice(customerId, lines: { amount: number }[], extra?)` - lines on item `1` "Services" (exists in the sandbox and is seeded in the fake), `get(entity, id)`, `expectFault(res, code)`.
  - `class FakeQbo implements QboClient`, `constructor(opts?: { now?: () => Date; realmId?: string })`. Seeded like the sandbox (qbo-spec 1): Account `1` "Services" (Income), Account `4` "Undeposited Funds", Account `84` "Accounts Receivable (A/R)", Item `1` "Services" (Service, income account `1`). New ids are numeric strings counting from `1000` per entity type.
  - Supported transport surface (anything else throws `Error('FakeQbo: unsupported <method> <path>')`):
    - `GET /<entity>/<id>` → `200 { <Entity>: {...}, time }` or `400` fault `610` "Object Not Found"
    - `POST /<entity>` without `Id` → create; with `Id` + `sparse: true` → sparse update (non-sparse updates throw: the fake supports only what the sync sends)
    - `GET /query` with `select * from <Entity>` or `select * from <Entity> where <Field> = '<value>'` for `Id`, `DocNumber`, `DisplayName`, `Name` (string compare ignoring case; inactive records excluded as in QBO) → `{ QueryResponse: { <Entity>: [...] } | {}, time }`
  - Invoice reads append QBO's computed line `{ DetailType: 'SubTotalLineDetail', Amount: <sum> }`; `TotalAmt`, `Balance`, `LinkedTxn` are computed.

Contract tests added in this task (each `it` inside `qboContract`):
- `GET of an unknown id is 610`
- `a create returns SyncToken "0" and the computed total` (lines 10 + 20 → `TotalAmt` 30, `Balance` 30)
- `a no-op sparse update keeps SyncToken` (resend `PrivateNote` unchanged → same `SyncToken`, same `LastUpdatedTime`)
- `a real sparse update bumps SyncToken by one`
- `a stale SyncToken is rejected with 5010`
- `sparse Line replaces all lines` (two lines, update with line 2 only → one line, `Id` of line 2 kept)
- `DocNumber is not unique; a query by DocNumber returns both` (case-insensitive: query in lower case)
- `customer DisplayName is unique ignoring case (6240)`
- `an invoice for an unknown item is rejected (2500) and nothing is written`

- [ ] **Step 1: Write the suite and `qbo-fake.test.ts`** (`qboContract({ client: () => new FakeQbo(), prefix: 'f' + random(5), settle: (read) => read() })` - a fresh fake per `it`: build it in `beforeEach` and let `client()` return the current one).
- [ ] **Step 2: Run to see them fail** - `pnpm test test/contract` → FAIL, `FakeQbo` missing.
- [ ] **Step 3: Implement the fake's records, SyncToken and query subset.** `SyncToken` is a string counter that changes only when a sparse update changes a stored field (deep compare); `LastUpdatedTime` from `now()` truncated to whole seconds.
- [ ] **Step 4: Run to see them pass**, then `pnpm check`.
- [ ] **Step 5: Commit** - `test: add the QBO contract suite and a fake QBO with records and queries`.

---

### Task 9: Fake QBO: requestid, void, delete, payments

**Files:**
- Modify: `test/fakes/fake-qbo.ts`, `test/contract/qbo-contract.ts`

**Interfaces:**
- Supported surface added: `?requestid=` on any write; `POST /invoice?operation=void`; `POST /invoice|payment?operation=delete`; `POST /payment` create and sparse update; `POST /payment?operation=update&include=void`.

Behaviour (qbo-spec 7, 8, 9): requestid store keyed by `(entity type, key)` holding the successful response; replay returns it verbatim regardless of body or target; failed requests are not stored; key > 50 chars → `6000`. Void: lines' `Amount` 0 (Qty / UnitPrice removed), `PrivateNote` prefixed `"Voided - "`, SyncToken +1, linked payments unapplied. Delete: `SyncToken` required but not checked (missing → `2020`); afterwards GET / update / void / delete → `610`. Payments: apply lines to invoices (`LinkedTxn` on both sides), over-application clipped into `UnappliedAmt`, other customer's invoice → `620`, unknown invoice → `610`, lines above `TotalAmt` → `6000`, each change bumps the affected invoices' `SyncToken`. Reducing an invoice below what is applied shrinks the application (8.4); changing its `CustomerRef` unapplies its payments (9.2). Payment void → `TotalAmt` 0, `Line: []`, `PrivateNote: "Voided"`. No automatic credit application (DESIGN: not reproduced).

Contract tests added:
- `a create replayed with the same requestid returns the first record and ignores the new body` (second call with another `DocNumber` → same `Id`, first `DocNumber`; query count 1)
- `a requestid replay on an update returns the stored response even with a stale SyncToken`
- `void zeroes the invoice and prefixes PrivateNote with "Voided - "` (`TotalAmt` 0, `Balance` 0, every sales line `Amount` 0, SyncToken +1)
- `void unapplies the invoice's payment` (payment `UnappliedAmt` = its amount, `Line: []`; invoice `LinkedTxn: []`)
- `delete ignores a stale SyncToken; GET afterwards is 610`
- `a payment applies to an invoice and bumps its SyncToken` (100 paid 40 → `Balance` 60, `LinkedTxn` has the payment)
- `one payment applies 60 / 40 over two invoices`
- `reducing a paid invoice below the paid amount shrinks the application` (100 paid 100, lines → 70: invoice `Balance` 0, payment line 70, `UnappliedAmt` 30)
- `a payment void restores the invoice balance`

- [ ] **Step 1: Add the contract tests.**
- [ ] **Step 2: Run to see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to see them pass**, then `pnpm check`.
- [ ] **Step 5: Commit** - `test: add requestid, void, delete and payments to the fake QBO`.

---

### Task 10: Fake QBO: CDC, tax, webhooks and failures

**Files:**
- Modify: `test/fakes/fake-qbo.ts`, `test/contract/qbo-contract.ts`
- Create: `test/fakes/fake-qbo.test.ts`

**Interfaces:**
- Supported surface added: `GET /cdc?entities=<A,B>&changedSince=<ISO>` → `{ CDCResponse: [{ QueryResponse: [{ <Entity>: [...] } | {} ...] }], time }`: one entry per changed record in its current state, live records by `LastUpdatedTime` ascending then deleted stubs; `changedSince` exclusive at whole seconds.
- Tax (qbo-spec 5.2, 15): sales tax code `'2'`, rate `'0.08'`. Tax is computed only when lines have `TaxCodeRef: { value: 'TAX' }` and `TxnTaxDetail.TxnTaxCodeRef` is sent; `TotalTax = percentOf(sum of TAX lines, '0.08')`, `TotalAmt` includes it. Once an invoice carries `TxnTaxCodeRef`, a sparse update with `Line` but without `TxnTaxDetail.TxnTaxCodeRef` → `6000`; with it and `NON` lines → tax 0 and the code dropped.
- Fake controls:
  - `takeWebhooks(opts?: { duplicate?: boolean; reverse?: boolean; drop?: (e: QboWebhookEntity) => boolean }): QboWebhookEntity[]` - same semantics as the invoicing fake. Events per qbo-spec 14.3: Create / Update / Void / Delete for the written entity only (payment writes produce no Invoice event; no-op updates produce none).
  - `failNext(match: { method?: string; path?: string /* prefix */ }, failure: Failure | 'http_429' | 'http_500' | 'http_401' | 'http_425'): void` - one-shot; `timeout_after_write` applies the write (and stores the requestid response) then throws `timeoutError()`; `http_*` return that status without writing (`429` with `retry-after: 1`, `401` with the lowercase `fault` envelope of qbo-spec 3.1).
  - `uiSaveInvoice(id: string): void` - what saving in the QBO UI does (qbo-spec 15): adds `TxnTaxDetail.TxnTaxCodeRef` `'2'` and taxes the invoice at 8 % with lines kept `NON`; SyncToken +1; emits an Update event.

Contract tests added:
- `CDC returns each changed record once in its current state` (create, update twice → one entry with the last `SyncToken`)
- `CDC returns a Deleted stub for a deleted invoice`
- `CDC changedSince is exclusive` (read an invoice's `LastUpdatedTime` t; `changedSince = t` excludes it, `t - 1 s` includes it)
- `computes 8 % tax when both tax codes are sent` (one TAX line 100 + `TxnTaxCodeRef` `2` → `TotalTax` 8, `TotalAmt` 108)
- `a line update on a taxed invoice without TxnTaxCodeRef fails with 6000`
- `a line update with TxnTaxCodeRef and NON lines drops the tax`

Fake-only tests (`test/fakes/fake-qbo.test.ts`): `emits Create, Update, Void, Delete webhooks for invoice writes`, `a payment emits only a Payment event`, `a no-op update emits nothing`, `takeWebhooks can duplicate, reverse and drop`, `timeout after write applies the create and a requestid retry returns it` (rejects with `name === 'TimeoutError'`; retry same key → same `Id`; query count 1), `http_429 carries retry-after and writes nothing`, `http_401 uses the lowercase fault envelope`, `uiSaveInvoice taxes a 15.00 invoice at 1.20` (`TotalAmt` 16.20, `TxnTaxCodeRef` 2, lines `NON`).

- [ ] **Step 1: Add the contract and fake tests.**
- [ ] **Step 2: Run to see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to see them pass**, then `pnpm check`.
- [ ] **Step 5: Commit** - `test: add CDC, tax, webhooks and failure injection to the fake QBO`.

---

### Task 11: Run the contract suite against the sandbox

**Files:**
- Create: `test/harness/eventually.ts`, `test/unit/harness/eventually.test.ts`, `test/e2e/sandbox-client.ts`, `test/e2e/qbo-sandbox.test.ts`
- Modify: `CLAUDE.md` (Development: `pnpm test:e2e` needs `pnpm qbo:auth` first), `PROGRESS.md` (Now / Next, status rows, decision log: fake QBO at transport level)

**Interfaces:**
- Produces:
  - `eventually<T>(read: () => Promise<T>, ok: (v: T) => boolean, opts?: { timeoutMs?: number; intervalMs?: number }): Promise<T>` - defaults 10 000 / 250 ms; on timeout throws with the last value in the message.
  - `sandboxClient(): QboClient` - from `qbo-playground/src/setup.ts` `client()`; throws `"QBO is not connected: run pnpm qbo:auth"` when no connection file exists (check before building the client).

- [ ] **Step 1: Write the failing `eventually` tests**: `returns once ok`, `retries until ok` (third read ok), `throws after the timeout with the last value` (fake timers).
- [ ] **Step 2: Run to see them fail; implement; run to see them pass.**
- [ ] **Step 3: `test/e2e/qbo-sandbox.test.ts`**: `qboContract({ client: sandboxClient, prefix: 'e' + random(5), settle: eventually })`.
- [ ] **Step 4: Run against the sandbox**

Run: `pnpm test:e2e`
Expected: every contract test passes, and the cleanup leaves no open invoices with the run prefix (`pnpm qbo:call query "select * from Invoice where DocNumber like 'e%'"` shows none from this run). A failure here means the fake and the sandbox disagree: fix the fake (or the suite's assumption) and re-run both `pnpm test` and `pnpm test:e2e`, never weaken the assertion to pass on one side only.

- [ ] **Step 5: Update `CLAUDE.md` and `PROGRESS.md`**, then `pnpm check`.
- [ ] **Step 6: Commit** - `test: run the QBO contract suite against the sandbox`.

---

## Self-review notes

- Spec coverage: DESIGN 4 (fake fidelity list, controls, fresh DB, contract tests against both, e2e prefix / sequential / cleanup, e2e outside `pnpm check`) → Tasks 1, 3, 8-11. `docs/INVOICING.md` data, rules, API, notifications → Tasks 4-6. Things deliberately not here: `createWorld`, intake, worker, delivery of webhooks to the sync (plan 2); ★ scenarios, invariants, GeneralLedger report (plan 3).
- Open item for plan 2: DESIGN 5 lists a deposit account in a payment's neutral form, but `docs/INVOICING.md` payments have none. Resolve before the payment mapping (likely: drop it from the neutral form; QBO uses its default deposit account).
