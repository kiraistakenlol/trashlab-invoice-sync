# Review feedback and fix plan

<!-- last-updated: 2026-10-23 -->

The first submission (2026-10-19) was reviewed and passed. The reviewer asked for the points
below to be fixed before the final submission. This file is the work list: pick the next
open task, do it, tick it, commit.

## The feedback

- "Doesn't handle edge cases properly (e.g. a 1500-character memo)."
- "Too dense code and logic."
- Area to improve: **code quality** - code smells, excessive AI usage, improper stack
  idioms and practices.

## What "too dense" most likely points at

A read of `src/` (2026-10-21), worst first:

1. `src/sync/engine.ts` (490 lines): one generic `Run<N>` class with ~18 private methods;
   `apply` and `write` return `string | null | typeof FLAGGED` - a Symbol as a "flagged"
   sentinel is the most unusual idiom in the repo.
2. `Run.firstSight` (~51 lines): adopts an in-flight create, matches, checks taken and
   blocked, inserts the link, then branches three ways; six early returns.
3. `Run.parked` (~41 lines): `sides && diff(...)`, `sides && d && await guard(...)`, a
   ternary holding a conditional spread.
4. `engine.ts:64-90`: seven one-line arrow helpers in a row; `storedVersion` is a nested
   ternary.
5. `Run.createCounterpart`: patches built from spreads such as
   `...(current && versionPatch(source, side.version))` - the reader has to work out what
   is written.
6. `map-qbo.ts` (`*Patch`, `invoicePatch` nests a spread inside a spread) and
   `map-invoicing.ts`: whole functions made of `...(cond && {...})` (31 in `src/`).
7. Every spec: `system === 'invoicing' ? await A(ctx, await B()) : await C(ctx, await D())`
   - `invoice.ts`, `payment.ts`, `catalogue.ts`; the same read / create / update shape
   five times.
8. `invoice.ts` `guard`: five rules in one function; a cast inside a boolean chain.
9. `payment.ts` `unlinkedTwins`: a ternary choosing between two map / filter chains plus a
   destructure with rest; the same sort comparator written twice.
10. `qbo/api.ts` `changes()`: a cast, loops three deep, `new Date(Math.max(...))`.
11. `http/server.ts` `buildServer` (~204 lines): every route with its schema inline.
12. `resolve.ts:62-78`: a function defined inside a function, a ternary of objects spread
    into `updateLink`.

Signals that read as AI-written:

- Machinery heavy for five entity types: `EntitySpec<N>` with six optional hooks, the
  neutral model, `toLinkFn` / `toSideFn` higher-order resolvers, the generic `Run<N>`.
- One telegraphic comment above nearly every function.
- ~18k words of docs against ~4.3k lines of code; `CLAUDE.md` and
  `docs/how-it-was-built.md` in the repo.
- Copies instead of one helper: `UNIQUE_VIOLATION` and the `.code` check in `links.ts`
  and `jobs.ts`; `message(error)` written three times (`engine.ts` twice, `worker.ts`).
- Odd names: `FLAGGED`, `note`, `parked`, `twins`, `asIs`, `converged`, `freePayments`,
  `matchOf`, `created()`.

Stack idioms:

- Three styles mixed: classes (`Run`, `QboApi`), factory closures (`createWorker`,
  `createPollLoop`) and object literals of arrows (`qboToNeutral`).
- `if (x) a; else b` without braces (`worker.ts:57-59`, `payment.ts:173`).
- `as` casts on JSON and snapshots (~40) and `!` assertions (~12).
- ESLint has no `no-nested-ternary`, `curly`, `max-depth` or complexity limits.
- Tests: helper closures piled at the top of files, heavy `!`.

## Tasks

Keep behaviour unchanged unless a task says otherwise; `pnpm check` (lint, types, all
tests) must pass after each one. Commit per task.

- [x] **1. Text too long for QBO** - limits verified on the sandbox
  (`qbo-playground/src/explore/14-text-limits.ts`, `qbo-spec.md`): memo 1000, line
  description 4000, customer name 500, item / account name 100, invoice number 21.
  Checked before every QBO create and update (`src/qbo/limits.ts`); an over-long value
  flags the record `unsupported` instead of failing the job. Scenario U8,
  `test/scenarios/text-limits.test.ts`, `test/unit/qbo/limits.test.ts`. (`58b39a3`)
- [x] **0. Broken test** - `worker.test.ts` expected the old `entityType` log field; it
  was failing in the first submission. (`afdd1b3`)
- [x] **2. Lint rules** - `curly`, `no-nested-ternary` and `max-depth` (3) are errors
  everywhere; `complexity` (10) and `max-lines-per-function` (40) are errors in `src/`.
  (`1b16f2e`, then flipped by 3-7)
- [x] **3-7. Density refactor**, done as one piece:
  - mappers are plain named functions (`fromQboInvoice`, `toInvoicingItemPatch`, ...) that
    build objects with `if`, no conditional spreads; QBO write bodies are typed;
  - `EntitySpec` holds one set of operations per system (`spec.invoicing.read`,
    `spec.qbo.update`, ...), so no spec branches on `system`;
  - engine: `FLAGGED` replaced by a `WriteOutcome` result, the long methods split into
    named steps, link id / version patches set through `setSideId` / `setVersion`;
    `readNormalized` shared by the engine, conflict resolution and the invariants test;
  - shared `isUniqueViolation` and `errorMessage`; renames (`note` -> `auditRecord`,
    `parked` -> `holdForIssues`, `twins` -> `matchingPayments`, `freePayments` ->
    `releaseAllocations`, `asIs` -> `keepSideIds`, `matchOf` -> `matchIds`, `created()` ->
    `expectLive`);
  - worker, clients, config, poll loop: inner functions hoisted out of the factories;
  - server: QBO webhook, invoicing webhook and operator API are Fastify plugins with their
    schemas beside them; `buildServer` only wires them.
  Not done: classes and factory functions are still both used (`Run`, `QboApi` vs
  `createWorker`, ...); the size rules don't cover `test/`, `invoicing-sim/`, `demo/`.
- [x] **Race found by the demo** - a job that read the pair before an operator resolved its
  conflict reopened it. An issue on a link is now opened in the transaction that moves the
  link on from the version the job read, so such a job reruns instead. Scenario F4.
- [-] **8. Docs** - skipped: the reviewer did not mention docs, and the assignment values
  written trade-off reasoning.
- [-] **Stack idioms** (TypeBox route schemas, Kysely `CamelCasePlugin`, schema-validated
  API responses, one component style) - skipped: a guess at a vague comment, and wide
  changes right before resubmitting.
- [ ] **9. Before resubmitting** - ZIP the repo as it is, `CLAUDE.md` included; run the
  reviewer's Take Home Checker on the result; record a fresh demo if the behaviour
  changed. Send the ZIP **by email to Julieta** (her answer 2026-10-23), not Ashby.
