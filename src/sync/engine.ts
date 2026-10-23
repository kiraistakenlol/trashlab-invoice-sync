// The reconcile algorithm: brings one record's pair in line from the current state of both sides.
import { isDeepStrictEqual } from 'node:util'
import type { AuditAction, EntityType, IssueKind, RecordRef, System } from '../db/database.js'
import { errorMessage } from '../error-message.js'
import { audit, type AuditEntry, type FieldChanges } from '../store/audit.js'
import {
  openIssue,
  openIssues,
  resolveIssue,
  updateIssueDetails,
  type Issue,
} from '../store/issues.js'
import {
  findLink,
  insertLink,
  pendingLinks,
  setSideId,
  setVersion,
  storedVersion,
  updateLink,
  type Link,
  type LinkPatch,
} from '../store/links.js'
import type { SyncContext } from './context.js'
import { diff, type Diff } from './diff.js'
import { asFlag, classify, StaleError } from './errors.js'
import type { Side } from './neutral.js'
import { specFor } from './specs/index.js'

export type Live<N> = Extract<Side<N>, { state: 'live' }>

export type Match =
  { found: 'none' } | { found: 'one'; id: string } | { found: 'many' | 'taken'; ids: string[] }

export interface Flag {
  kind: IssueKind
  reason: string
}

// What reading, matching and writing one entity type means on one system.
export interface SystemOps<N extends object> {
  read(ctx: SyncContext, id: string): Promise<Side<N>>
  // looks for a counterpart of `fields` on this system
  match(ctx: SyncContext, fields: N): Promise<Match>
  // a FlagError is thrown only before anything is sent
  create(ctx: SyncContext, fields: N, idempotencyKey: string): Promise<Live<N>>
  update(ctx: SyncContext, side: Live<N>, changes: Partial<N>, merged: N): Promise<string>
  remove?(ctx: SyncContext, side: Live<N>): Promise<void>
}

// One entity type: its operations on each system and the rules that hold across both.
export interface EntitySpec<N extends object> {
  entityType: EntityType
  invoicing: SystemOps<N>
  qbo: SystemOps<N>
  // how a write of `changes` is audited; 'updated' by default
  updateAction?(changes: Partial<N>): UpdateAction
  // a state the record can't leave once in it
  final?(fields: N): boolean
  // the fields a side is diffed with, given the last synced snapshot
  normalize?(fields: N, snapshot: N): N
  // why a record can't be created on the target system, when it can't
  createBlocked?(fields: N, target: System): string | null
  // rules beyond the field diff that park the pair
  guard?(
    ctx: SyncContext,
    link: Link,
    sides: { invoicing: Live<N>; qbo: Live<N> },
    diff: Diff<N>
  ): Promise<Flag | null>
}

export type UpdateAction = Extract<AuditAction, 'updated' | 'voided'>

type Versions = { invoicing: string | null; qbo: string | null }

// a write that can't go ahead flags the pair instead of running
type WriteOutcome<T> = { blocked: false; result: T } | { blocked: true }

export const otherSystem = (system: System): System =>
  system === 'invoicing' ? 'qbo' : 'invoicing'

// A side read as the diff sees it: normalized against the last synced snapshot.
export async function readNormalized<N extends object>(
  ctx: SyncContext,
  spec: EntitySpec<N>,
  system: System,
  id: string,
  snapshot: N | null
): Promise<Side<N>> {
  const side = await spec[system].read(ctx, id)
  if (side.state !== 'live' || !spec.normalize || snapshot === null) {
    return side
  }
  return { ...side, fields: spec.normalize(side.fields, snapshot) }
}

export async function reconcile(ctx: SyncContext, ref: RecordRef, jobId?: string): Promise<void> {
  const job = jobId === undefined ? ctx : { ...ctx, jobId }
  const spec = specFor(ref.entityType)
  for (let attempt = 0; ; attempt++) {
    try {
      return await new Run(job, spec, ref).start()
    } catch (error) {
      if (classify(error).kind !== 'stale' || attempt >= ctx.config.staleRetries) {
        throw error
      }
      const reason = errorMessage(error)
      job.log.info({ ...logFields(job, ref), attempt, reason }, 'stale, reconciling again')
    }
  }
}

const logFields = (ctx: SyncContext, ref: RecordRef) => ({
  jobId: ctx.jobId,
  system: ref.system,
  entity: ref.entityType,
  entityId: ref.entityId,
})

function fieldChanges<N extends object>(
  values: Partial<N>,
  snapshot: N | null,
  source: System
): FieldChanges {
  const base = snapshot as Record<string, unknown> | null
  return Object.fromEntries(
    Object.entries(values).map(([field, to]) => [
      field,
      { from: base?.[field] ?? null, to, source },
    ])
  )
}

// the system holding a half-made link's record, and its id there
function loneSide(link: Link): { system: System; id: string } {
  if (link.invoicingId !== null) {
    return { system: 'invoicing', id: link.invoicingId }
  }
  if (link.qboId !== null) {
    return { system: 'qbo', id: link.qboId }
  }
  throw new Error(`link ${link.id} holds no record`)
}

function pairIds(link: Link): { invoicing: string; qbo: string } {
  if (link.invoicingId === null || link.qboId === null) {
    throw new Error(`link ${link.id} is not paired`)
  }
  return { invoicing: link.invoicingId, qbo: link.qboId }
}

const versionOf = <N>(side: Side<N>): string | null => (side.state === 'live' ? side.version : null)

// One pass over the pair; any stale read or write restarts it from scratch.
class Run<N extends object> {
  constructor(
    private readonly ctx: SyncContext,
    private readonly spec: EntitySpec<N>,
    private readonly ref: RecordRef
  ) {}

  async start(): Promise<void> {
    const { entityType, system, entityId } = this.ref
    const link = await findLink(this.ctx.db, entityType, system, entityId)
    if (!link) {
      return this.firstSight()
    }
    if (link.deletedAt) {
      return this.auditRecord('no_change', { deleted: true })
    }
    if (link.invoicingId === null || link.qboId === null) {
      return this.createCounterpart(link)
    }
    return this.pair(link)
  }

  // No link yet: adopt our own in-flight create, link to a matching counterpart, or start
  // creating one.
  private async firstSight(): Promise<void> {
    const { ref, spec } = this
    const side = await spec[ref.system].read(this.ctx, ref.entityId)
    if (side.state !== 'live') {
      return this.skipUnlinked(side)
    }
    const inFlight = await this.inFlightCreate(side.fields)
    if (inFlight) {
      return this.adopt(inFlight)
    }
    const target = otherSystem(ref.system)
    const match = await spec[target].match(this.ctx, side.fields)
    const refusal = await this.linkRefusal(match, target, side.fields)
    if (refusal) {
      return this.flag(null, refusal.kind, refusal.details)
    }
    const counterpartId = match.found === 'one' ? match.id : null
    const link = await this.insertLink(counterpartId)
    await this.resolveRefIssues()
    if (counterpartId === null) {
      return this.createCounterpart(link, side)
    }
    this.log({ linkId: link.id }, 'linked to a match')
    const { invoicingId, qboId } = link
    await this.auditRecord('linked', { linkId: link.id, invoicingId, qboId })
    return this.pair(link)
  }

  private skipUnlinked(side: Exclude<Side<N>, { state: 'live' }>): Promise<void> {
    if (side.state === 'gone') {
      return this.auditRecord('no_change', { gone: this.ref.system })
    }
    if (side.state === 'ignored') {
      return this.auditRecord('no_change', { ignored: side.reason })
    }
    return this.flag(null, 'unsupported', { reason: side.reason })
  }

  // the link of our own create whose record just landed here, before the create returned
  private async inFlightCreate(fields: N): Promise<Link | null> {
    const pending = await pendingLinks(this.ctx.db, this.ref.entityType, this.ref.system)
    const same = pending.filter((l) => isDeepStrictEqual(l.snapshot, fields))
    return same.length === 1 ? (same[0] ?? null) : null
  }

  private async adopt(pending: Link): Promise<void> {
    const patch: LinkPatch = {}
    setSideId(patch, this.ref.system, this.ref.entityId)
    const adopted = await this.save(pending, patch)
    this.log({ linkId: adopted.id }, 'adopted an in-flight create')
    await this.auditRecord('linked', { linkId: adopted.id, adopted: true })
    await this.resolveRefIssues()
    return this.pair(adopted)
  }

  // Why the record can't be linked to its match, or have a counterpart created when it has none.
  private async linkRefusal(
    match: Match,
    target: System,
    fields: N
  ): Promise<{ kind: IssueKind; details: Record<string, unknown> } | null> {
    if (match.found === 'many' || match.found === 'taken') {
      const kind = match.found === 'many' ? 'ambiguous_match' : 'number_taken'
      return { kind, details: { reason: `${target} has candidates`, candidates: match.ids } }
    }
    if (match.found === 'one') {
      const taken = await findLink(this.ctx.db, this.ref.entityType, target, match.id)
      if (!taken) {
        return null
      }
      const details = { reason: 'candidate already linked', candidate: match.id, linkId: taken.id }
      return { kind: 'ambiguous_match', details }
    }
    const blocked = this.spec.createBlocked?.(fields, target) ?? null
    return blocked === null ? null : { kind: 'unsupported', details: { reason: blocked } }
  }

  private async insertLink(counterpartId: string | null): Promise<Link> {
    const { ref } = this
    const ids =
      ref.system === 'invoicing'
        ? { invoicingId: ref.entityId, qboId: counterpartId }
        : { invoicingId: counterpartId, qboId: ref.entityId }
    const link = await insertLink(this.ctx.db, ref.entityType, ids)
    if (!link) {
      throw new StaleError(`${ref.system} ${ref.entityType} ${ref.entityId} was linked`)
    }
    return link
  }

  // Issues raised while the record had no link are settled once it has one.
  private async resolveRefIssues(): Promise<void> {
    for (const issue of await openIssues(this.ctx.db, { ref: this.ref })) {
      if (issue.linkId !== null) {
        continue
      }
      if (!(await resolveIssue(this.ctx.db, issue.id, 'converged', this.ctx.clock.now()))) {
        continue
      }
      this.log({ issueId: issue.id, kind: issue.kind }, 'issue resolved: record linked')
      await this.auditRecord('issue_resolved', { issueId: issue.id, kind: issue.kind })
    }
  }

  // A link with one id: create the record on the other side under the link's key, always from
  // the fields first pending on the link, so a retry resends the same body.
  private async createCounterpart(link: Link, known?: Live<N>): Promise<void> {
    const source = loneSide(link)
    const side = known ?? (await this.spec[source.system].read(this.ctx, source.id))
    if (side.state === 'gone') {
      await this.save(link, { deletedAt: this.ctx.clock.now() })
      await this.resolveConverged(await openIssues(this.ctx.db, { linkId: link.id }))
      return this.auditRecord('no_change', { gone: source.system })
    }
    if (side.state !== 'live') {
      return this.flag(link, 'unsupported', { reason: side.reason })
    }
    const pending = link.snapshot === null ? await this.save(link, { snapshot: side.fields }) : link
    const fields = pending.snapshot as N
    const target = otherSystem(source.system)
    const changes = fieldChanges(fields, null, source.system)
    // nothing is sent when the create is blocked, so the next attempt creates from the source
    // as it is then
    const created = await this.write(
      pending,
      { ref: this.ref, action: 'created', changes },
      () => this.spec[target].create(this.ctx, fields, pending.createIdempotencyKey),
      { snapshot: null }
    )
    if (created.blocked) {
      return
    }
    return this.linkCreated(pending, side, target, created.result, changes)
  }

  private async linkCreated(
    pending: Link,
    source: Live<N>,
    target: System,
    created: Live<N>,
    changes: FieldChanges
  ): Promise<void> {
    this.log({ linkId: pending.id, target, createdId: created.id }, 'created counterpart')
    const details = { linkId: pending.id }
    await this.audit({ ref: this.refOn(target, created.id), action: 'created', changes, details })
    const patch: LinkPatch = { snapshot: created.fields }
    setSideId(patch, target, created.id)
    setVersion(patch, target, created.version)
    // a replayed create returns the record as first written; a newer source change is then
    // still to be copied
    const current = isDeepStrictEqual(source.fields, created.fields)
    if (current) {
      setVersion(patch, otherSystem(target), source.version)
    }
    const saved = await this.save(pending, patch)
    // a pair parked while the create was blocked closes once both sides agree
    const parked = (await openIssues(this.ctx.db, { linkId: pending.id })).length > 0
    if (!current || parked) {
      return this.pair(saved)
    }
  }

  private async pair(link: Link): Promise<void> {
    const ids = pairIds(link)
    const snapshot = link.snapshot as N | null
    const { ctx, spec } = this
    const invoicing = await readNormalized(ctx, spec, 'invoicing', ids.invoicing, snapshot)
    const qbo = await readNormalized(ctx, spec, 'qbo', ids.qbo, snapshot)
    const versions = { invoicing: versionOf(invoicing), qbo: versionOf(qbo) }
    const issues = await openIssues(ctx.db, { linkId: link.id })
    if (issues.length > 0) {
      return this.holdForIssues(link, issues, invoicing, qbo, versions)
    }
    if (invoicing.state === 'gone' || qbo.state === 'gone') {
      return this.oneOrBothGone(link, invoicing, qbo, versions)
    }
    if (invoicing.state !== 'live') {
      return this.flagUnsupported(link, 'invoicing', invoicing.reason, versions)
    }
    if (qbo.state !== 'live') {
      return this.flagUnsupported(link, 'qbo', qbo.reason, versions)
    }
    return this.sync(link, invoicing, qbo, versions)
  }

  // Both sides live and no issue open: each side's changes since the last sync go to the other,
  // unless they conflict or a spec rule holds them back.
  private async sync(
    link: Link,
    invoicing: Live<N>,
    qbo: Live<N>,
    versions: Versions
  ): Promise<void> {
    const unchanged =
      invoicing.version === storedVersion(link, 'invoicing') &&
      qbo.version === storedVersion(link, 'qbo')
    if (unchanged) {
      return this.auditRecord('no_change')
    }
    const d = diff(link.snapshot as N | null, invoicing.fields, qbo.fields)
    if (d.conflicts.length > 0) {
      return this.flag(link, 'conflict', { conflicts: d.conflicts, versions })
    }
    const held = await this.spec.guard?.(this.ctx, link, { invoicing, qbo }, d)
    if (held) {
      return this.flag(link, held.kind, { reason: held.reason, versions })
    }
    return this.copyChanges(link, invoicing, qbo, d)
  }

  private async copyChanges(
    link: Link,
    invoicing: Live<N>,
    qbo: Live<N>,
    d: Diff<N>
  ): Promise<void> {
    const merged = { ...invoicing.fields, ...d.toInvoicing } as N
    const toQbo = await this.update(link, qbo, d.toQbo, merged, 'invoicing')
    if (toQbo.blocked) {
      return
    }
    const toInvoicing = await this.update(link, invoicing, d.toInvoicing, merged, 'qbo')
    if (toInvoicing.blocked) {
      return
    }
    const patch: LinkPatch = { snapshot: merged }
    setVersion(patch, 'invoicing', toInvoicing.result ?? invoicing.version)
    setVersion(patch, 'qbo', toQbo.result ?? qbo.version)
    await this.save(link, patch)
    if (toQbo.result === null && toInvoicing.result === null) {
      return this.auditRecord('no_change')
    }
  }

  // Writes `values` to `side`; the result is its new version, or null when there was nothing to
  // write.
  private async update(
    link: Link,
    side: Live<N>,
    values: Partial<N>,
    merged: N,
    source: System
  ): Promise<WriteOutcome<string | null>> {
    if (Object.keys(values).length === 0) {
      return { blocked: false, result: null }
    }
    const system = otherSystem(source)
    const ref = this.refOn(system, side.id)
    const changes = fieldChanges(values, link.snapshot as N | null, source)
    const action = this.spec.updateAction?.(values) ?? 'updated'
    const written = await this.write(link, { ref, action, changes }, () =>
      this.spec[system].update(this.ctx, side, values, merged)
    )
    if (!written.blocked) {
      this.log({ target: system, fields: Object.keys(values) }, action)
      await this.audit({ ref, action, changes })
    }
    return written
  }

  // An open issue: nothing is written; it closes once both sides agree or both are gone.
  private async holdForIssues(
    link: Link,
    issues: Issue[],
    invoicing: Side<N>,
    qbo: Side<N>,
    versions: Versions
  ): Promise<void> {
    if (invoicing.state === 'gone' && qbo.state === 'gone') {
      await this.resolveConverged(issues)
      return this.closeDeleted(link, 'both')
    }
    if (invoicing.state !== 'live' || qbo.state !== 'live') {
      return this.refreshIssues(issues, versions, null, null)
    }
    if (isDeepStrictEqual(invoicing.fields, qbo.fields)) {
      const patch: LinkPatch = { snapshot: invoicing.fields }
      setVersion(patch, 'invoicing', invoicing.version)
      setVersion(patch, 'qbo', qbo.version)
      await this.save(link, patch)
      return this.resolveConverged(issues)
    }
    const d = diff(link.snapshot as N | null, invoicing.fields, qbo.fields)
    const held = (await this.spec.guard?.(this.ctx, link, { invoicing, qbo }, d)) ?? null
    return this.refreshIssues(issues, versions, d, held)
  }

  // Keeps each open issue's details current; a reason the guard no longer gives stays as the
  // issue was opened with.
  private async refreshIssues(
    issues: Issue[],
    versions: Versions,
    d: Diff<N> | null,
    held: Flag | null
  ): Promise<void> {
    for (const issue of issues) {
      const details: Record<string, unknown> = { ...issue.details, versions }
      if (issue.kind === 'conflict' && d !== null) {
        details.conflicts = d.conflicts
        if (held?.kind === 'conflict') {
          details.reason = held.reason
        }
      }
      await updateIssueDetails(this.ctx.db, issue.id, details)
    }
    await this.auditRecord('no_change', { parked: issues[0]?.id })
  }

  // A delete on one side removes the other, unless that one changed since the last sync.
  private async oneOrBothGone(
    link: Link,
    invoicing: Side<N>,
    qbo: Side<N>,
    versions: Versions
  ): Promise<void> {
    const gone: System = invoicing.state === 'gone' ? 'invoicing' : 'qbo'
    const kept = otherSystem(gone)
    const side = kept === 'invoicing' ? invoicing : qbo
    if (side.state === 'gone') {
      return this.closeDeleted(link, 'both')
    }
    if (side.state !== 'live') {
      return this.flagUnsupported(link, kept, side.reason, versions)
    }
    if (side.version !== storedVersion(link, kept)) {
      return this.flagDeleteConflict(link, gone, versions)
    }
    return this.removeCounterpart(link, side, gone, versions)
  }

  // Re-reads the kept side right before deleting it, so an edit made since is not lost.
  private async removeCounterpart(
    link: Link,
    side: Live<N>,
    gone: System,
    versions: Versions
  ): Promise<void> {
    const kept = otherSystem(gone)
    const fresh = await this.spec[kept].read(this.ctx, side.id)
    if (fresh.state === 'gone') {
      return this.closeDeleted(link, 'both')
    }
    if (fresh.state !== 'live' || fresh.version !== side.version) {
      return this.flagDeleteConflict(link, gone, versions)
    }
    const remove = this.spec[kept].remove
    if (!remove) {
      throw new Error(`${this.ref.entityType} cannot be deleted in ${kept}`)
    }
    const ref = this.refOn(kept, side.id)
    const removed = await this.write(link, { ref, action: 'deleted' }, () =>
      remove(this.ctx, fresh)
    )
    if (removed.blocked) {
      return
    }
    await this.save(link, { deletedAt: this.ctx.clock.now() })
    this.log({ linkId: link.id, target: kept }, 'deleted counterpart')
    await this.audit({ ref, action: 'deleted', details: { linkId: link.id, source: gone } })
  }

  private flagDeleteConflict(link: Link, gone: System, versions: Versions): Promise<void> {
    const reason = `deleted in ${gone}, changed in ${otherSystem(gone)}`
    return this.flag(link, 'conflict', { reason, versions })
  }

  private flagUnsupported(
    link: Link,
    system: System,
    reason: string,
    versions: Versions
  ): Promise<void> {
    return this.flag(link, 'unsupported', { reason, system, versions })
  }

  private async resolveConverged(issues: Issue[]): Promise<void> {
    for (const issue of issues) {
      if (!(await resolveIssue(this.ctx.db, issue.id, 'converged', this.ctx.clock.now()))) {
        continue
      }
      this.log({ issueId: issue.id, kind: issue.kind }, 'issue resolved: sides converged')
      await this.auditRecord('issue_resolved', { issueId: issue.id, kind: issue.kind })
    }
  }

  private async closeDeleted(link: Link, gone: string): Promise<void> {
    await this.save(link, { deletedAt: this.ctx.clock.now() })
    await this.auditRecord('no_change', { gone })
  }

  // Opens (or refreshes) an issue on the job's record and audits it. An issue on a link is
  // opened in the transaction that moves the link on from the version the job read (applying
  // `patch`), so a pair resolved or changed meanwhile reruns the job instead.
  private async flag(
    link: Link | null,
    kind: IssueKind,
    details: Record<string, unknown>,
    patch: LinkPatch = {}
  ): Promise<void> {
    const linkId = link?.id ?? null
    const by = link === null ? { ref: this.ref } : { linkId: link.id }
    const known = (await openIssues(this.ctx.db, by)).some((i) => i.kind === kind)
    const issue = await this.ctx.db.transaction().execute(async (tx) => {
      if (link !== null && !(await updateLink(tx, link, patch))) {
        throw new StaleError(`link ${link.id} changed underneath the job`)
      }
      return openIssue(tx, { ref: this.ref, linkId, kind, details })
    })
    this.log({ issueId: issue.id, kind }, known ? 'issue refreshed' : 'issue opened')
    await this.auditRecord(known ? 'no_change' : 'issue_opened', { issueId: issue.id, kind })
  }

  // Runs a write. One that can't go ahead flags the pair, applying `onBlocked` to the link; a
  // failed one is audited with its error and rethrown.
  private async write<T>(
    link: Link,
    entry: AuditEntry,
    run: () => Promise<T>,
    onBlocked: LinkPatch = {}
  ): Promise<WriteOutcome<T>> {
    try {
      return { blocked: false, result: await run() }
    } catch (error) {
      const flag = asFlag(error)
      if (!flag) {
        await this.audit({ ...entry, error: errorMessage(error) })
        throw error
      }
      const details = { reason: flag.reason, ...flag.details, blocked: true }
      await this.flag(link, flag.kind, details, onBlocked)
      return { blocked: true }
    }
  }

  private async save(link: Link, patch: LinkPatch): Promise<Link> {
    const saved = await updateLink(this.ctx.db, link, patch)
    if (!saved) {
      throw new StaleError(`link ${link.id} changed underneath the job`)
    }
    return saved
  }

  private refOn(system: System, entityId: string): RecordRef {
    return { system, entityType: this.ref.entityType, entityId }
  }

  private auditRecord(action: AuditEntry['action'], details?: object): Promise<void> {
    return this.audit({ ref: this.ref, action, details })
  }

  private audit(entry: Omit<AuditEntry, 'jobId'>): Promise<void> {
    return audit(this.ctx.db, { ...entry, jobId: this.ctx.jobId })
  }

  private log(fields: object, msg: string): void {
    this.ctx.log.info({ ...logFields(this.ctx, this.ref), ...fields }, msg)
  }
}
