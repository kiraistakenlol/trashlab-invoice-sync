// The reconcile algorithm: brings one record's pair in line from the current state of both sides.
import { isDeepStrictEqual } from 'node:util'
import type { EntityType, IssueKind, RecordRef, System } from '../db/database.js'
import { audit, type AuditEntry, type FieldChanges } from '../store/audit.js'
import { openIssue, openIssues, resolveIssue, type Issue } from '../store/issues.js'
import { findLink, insertLink, pendingLinks, updateLink, type Link } from '../store/links.js'
import type { SyncContext } from './context.js'
import { diff, type Diff } from './diff.js'
import { classify, StaleError } from './errors.js'
import type { Side } from './neutral.js'
import { specFor } from './specs/index.js'

export type Live<N> = Extract<Side<N>, { state: 'live' }>

export type Match =
  { found: 'none' } | { found: 'one'; id: string } | { found: 'many' | 'taken'; ids: string[] }

export interface Flag {
  kind: IssueKind
  reason: string
}

// What reading, matching and writing one entity type means on each side.
export interface EntitySpec<N extends object> {
  entityType: EntityType
  read(ctx: SyncContext, system: System, id: string): Promise<Side<N>>
  // looks for a counterpart in `system`
  match(ctx: SyncContext, system: System, fields: N): Promise<Match>
  create(ctx: SyncContext, system: System, fields: N, idempotencyKey: string): Promise<Live<N>>
  update(
    ctx: SyncContext,
    system: System,
    side: Live<N>,
    changes: Partial<N>,
    merged: N
  ): Promise<{ version: string }>
  remove?(ctx: SyncContext, system: System, side: Live<N>): Promise<void>
  // why a record can't be created on the target side, when it can't
  createBlocked?(fields: N, target: System): string | null
  // rules beyond the field diff that park the pair
  guard?(
    ctx: SyncContext,
    link: Link,
    sides: { invoicing: Live<N>; qbo: Live<N> },
    diff: Diff<N>
  ): Promise<Flag | null>
}

type Versions = { invoicing: string | null; qbo: string | null }

const other = (system: System): System => (system === 'invoicing' ? 'qbo' : 'invoicing')

const idOn = (link: Link, system: System): string | null =>
  system === 'invoicing' ? link.invoicingId : link.qboId

const idPatch = (system: System, id: string) =>
  system === 'invoicing' ? { invoicingId: id } : { qboId: id }

const versionPatch = (system: System, version: string) =>
  system === 'invoicing'
    ? { invoicingVersion: Number.parseInt(version, 10) }
    : { qboSyncToken: version }

const storedVersion = (link: Link, system: System): string | null =>
  system === 'invoicing'
    ? link.invoicingVersion === null
      ? null
      : String(link.invoicingVersion)
    : link.qboSyncToken

const versionOf = <N>(side: Side<N>): string | null => (side.state === 'live' ? side.version : null)

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

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

const conflictDetails = <N extends object>(d: Diff<N>, versions: Versions) => ({
  conflicts: d.conflicts,
  versions,
})

export async function reconcile(ctx: SyncContext, ref: RecordRef, jobId?: string): Promise<void> {
  const job = jobId === undefined ? ctx : { ...ctx, jobId }
  const spec = specFor(ref.entityType)
  for (let attempt = 0; ; attempt++) {
    try {
      return await new Run(job, spec, ref).start()
    } catch (error) {
      if (classify(error).kind !== 'stale' || attempt >= ctx.config.staleRetries) throw error
      job.log.info({ ...logFields(job, ref), attempt, err: error }, 'stale, reconciling again')
    }
  }
}

const logFields = (ctx: SyncContext, ref: RecordRef) => ({
  jobId: ctx.jobId,
  system: ref.system,
  entity: ref.entityType,
  entityId: ref.entityId,
})

// One pass over the pair; any stale read or write restarts it from scratch.
class Run<N extends object> {
  constructor(
    private readonly ctx: SyncContext,
    private readonly spec: EntitySpec<N>,
    private readonly ref: RecordRef
  ) {}

  async start(): Promise<void> {
    const link = await findLink(
      this.ctx.db,
      this.ref.entityType,
      this.ref.system,
      this.ref.entityId
    )
    if (!link) return this.firstSight()
    if (link.deletedAt) return this.note('no_change', { deleted: true })
    if (link.invoicingId === null || link.qboId === null) return this.createCounterpart(link)
    return this.pair(link)
  }

  // No link yet: adopt our own in-flight create, link to a matching counterpart, or start
  // creating one.
  private async firstSight(): Promise<void> {
    const { ref, spec } = this
    const side = await spec.read(this.ctx, ref.system, ref.entityId)
    if (side.state === 'gone') return this.note('no_change', { gone: ref.system })
    if (side.state !== 'live') {
      return side.state === 'ignored'
        ? this.note('no_change', { ignored: side.reason })
        : this.flag(null, 'unsupported', { reason: side.reason })
    }
    const pending = (await pendingLinks(this.ctx.db, ref.entityType, ref.system)).filter((l) =>
      isDeepStrictEqual(l.snapshot, side.fields)
    )
    if (pending.length === 1) {
      const adopted = await this.save(pending[0]!, idPatch(ref.system, ref.entityId))
      this.log({ linkId: adopted.id }, 'adopted an in-flight create')
      await this.note('linked', { linkId: adopted.id, adopted: true })
      await this.resolveRefIssues()
      return this.pair(adopted)
    }
    const target = other(ref.system)
    const match = await spec.match(this.ctx, target, side.fields)
    if (match.found === 'many' || match.found === 'taken') {
      const kind = match.found === 'many' ? 'ambiguous_match' : 'number_taken'
      return this.flag(null, kind, { reason: `${target} has candidates`, candidates: match.ids })
    }
    if (match.found === 'one') {
      const taken = await findLink(this.ctx.db, ref.entityType, target, match.id)
      if (taken) {
        return this.flag(null, 'ambiguous_match', {
          reason: 'candidate already linked',
          candidate: match.id,
          linkId: taken.id,
        })
      }
    }
    if (match.found === 'none') {
      const blocked = spec.createBlocked?.(side.fields, target) ?? null
      if (blocked !== null) return this.flag(null, 'unsupported', { reason: blocked })
    }
    const ids = {
      ...idPatch(ref.system, ref.entityId),
      ...(match.found === 'one' && idPatch(target, match.id)),
    }
    const link = await insertLink(this.ctx.db, ref.entityType, ids)
    if (!link) throw new StaleError(`${ref.system} ${ref.entityType} ${ref.entityId} was linked`)
    await this.resolveRefIssues()
    if (match.found === 'none') return this.createCounterpart(link, side)
    this.log({ linkId: link.id }, 'linked to a match')
    await this.note('linked', { linkId: link.id, ...ids })
    return this.pair(link)
  }

  // Issues raised while the record had no link are settled once it has one.
  private async resolveRefIssues(): Promise<void> {
    for (const issue of await openIssues(this.ctx.db, { ref: this.ref })) {
      if (issue.linkId !== null) continue
      await resolveIssue(this.ctx.db, issue.id, 'converged', this.ctx.clock.now())
      this.log({ issueId: issue.id, kind: issue.kind }, 'issue resolved: record linked')
      await this.note('issue_resolved', { issueId: issue.id, kind: issue.kind })
    }
  }

  // A link with one id: create the record on the other side under the link's key, always from
  // the fields first pending on the link, so a retry resends the same body.
  private async createCounterpart(link: Link, known?: Live<N>): Promise<void> {
    const source: System = link.invoicingId !== null ? 'invoicing' : 'qbo'
    const side = known ?? (await this.spec.read(this.ctx, source, idOn(link, source)!))
    if (side.state === 'gone') {
      await this.save(link, { deletedAt: this.ctx.clock.now() })
      return this.note('no_change', { gone: source })
    }
    if (side.state !== 'live') return this.flag(link.id, 'unsupported', { reason: side.reason })
    const pending = link.snapshot === null ? await this.save(link, { snapshot: side.fields }) : link
    const fields = pending.snapshot as N
    const target = other(source)
    const changes = fieldChanges(fields, null, source)
    const created = await this.write({ ref: this.ref, action: 'created', changes }, () =>
      this.spec.create(this.ctx, target, fields, pending.createIdempotencyKey)
    )
    this.log({ linkId: link.id, target, createdId: created.id }, 'created counterpart')
    await this.audit({
      ref: this.refOn(target, created.id),
      action: 'created',
      changes,
      details: { linkId: link.id },
    })
    // a replayed create returns the record as first written; a newer source change is then
    // still to be copied
    const current = isDeepStrictEqual(side.fields, created.fields)
    const saved = await this.save(pending, {
      ...idPatch(target, created.id),
      snapshot: created.fields,
      ...versionPatch(target, created.version),
      ...(current && versionPatch(source, side.version)),
    })
    if (!current) return this.pair(saved)
  }

  private async pair(link: Link): Promise<void> {
    const invoicing = await this.spec.read(this.ctx, 'invoicing', link.invoicingId!)
    const qbo = await this.spec.read(this.ctx, 'qbo', link.qboId!)
    const snapshot = link.snapshot as N | null
    const versions = { invoicing: versionOf(invoicing), qbo: versionOf(qbo) }

    const issues = await openIssues(this.ctx.db, { linkId: link.id })
    if (issues.length > 0) return this.parked(link, issues, invoicing, qbo, snapshot, versions)

    if (invoicing.state === 'gone' || qbo.state === 'gone') {
      return this.oneOrBothGone(link, invoicing, qbo, versions)
    }
    if (invoicing.state !== 'live') {
      return this.flag(link.id, 'unsupported', {
        reason: invoicing.reason,
        system: 'invoicing',
        versions,
      })
    }
    if (qbo.state !== 'live') {
      return this.flag(link.id, 'unsupported', { reason: qbo.reason, system: 'qbo', versions })
    }

    if (
      invoicing.version === storedVersion(link, 'invoicing') &&
      qbo.version === storedVersion(link, 'qbo')
    ) {
      return this.note('no_change')
    }
    const d = diff(snapshot, invoicing.fields, qbo.fields)
    if (d.conflicts.length > 0) return this.flag(link.id, 'conflict', conflictDetails(d, versions))
    const flagged = await this.spec.guard?.(this.ctx, link, { invoicing, qbo }, d)
    if (flagged) return this.flag(link.id, flagged.kind, { reason: flagged.reason, versions })

    const merged = { ...invoicing.fields, ...d.toInvoicing } as N
    const toQbo = await this.apply(qbo, d.toQbo, merged, snapshot, 'invoicing')
    const toInvoicing = await this.apply(invoicing, d.toInvoicing, merged, snapshot, 'qbo')
    await this.save(link, {
      snapshot: merged,
      ...versionPatch('invoicing', toInvoicing ?? invoicing.version),
      ...versionPatch('qbo', toQbo ?? qbo.version),
    })
    if (toQbo === null && toInvoicing === null) return this.note('no_change')
  }

  // Writes `values` to `side`; returns its new version, or null when there was nothing to write.
  private async apply(
    side: Live<N>,
    values: Partial<N>,
    merged: N,
    snapshot: N | null,
    source: System
  ): Promise<string | null> {
    if (Object.keys(values).length === 0) return null
    const system = other(source)
    const ref = this.refOn(system, side.id)
    const changes = fieldChanges(values, snapshot, source)
    const { version } = await this.write({ ref, action: 'updated', changes }, () =>
      this.spec.update(this.ctx, system, side, values, merged)
    )
    this.log({ target: system, fields: Object.keys(values) }, 'updated')
    await this.audit({ ref, action: 'updated', changes })
    return version
  }

  // An open issue: nothing is written; it closes once both sides agree.
  private async parked(
    link: Link,
    issues: Issue[],
    invoicing: Side<N>,
    qbo: Side<N>,
    snapshot: N | null,
    versions: Versions
  ): Promise<void> {
    if (
      invoicing.state === 'live' &&
      qbo.state === 'live' &&
      isDeepStrictEqual(invoicing.fields, qbo.fields)
    ) {
      await this.save(link, {
        snapshot: invoicing.fields,
        ...versionPatch('invoicing', invoicing.version),
        ...versionPatch('qbo', qbo.version),
      })
      for (const issue of issues) {
        await resolveIssue(this.ctx.db, issue.id, 'converged', this.ctx.clock.now())
        this.log({ issueId: issue.id, kind: issue.kind }, 'issue resolved: sides converged')
        await this.note('issue_resolved', { issueId: issue.id, kind: issue.kind })
      }
      return
    }
    for (const issue of issues) {
      const details =
        issue.kind === 'conflict' && invoicing.state === 'live' && qbo.state === 'live'
          ? conflictDetails(diff(snapshot, invoicing.fields, qbo.fields), versions)
          : { ...issue.details, versions }
      await openIssue(this.ctx.db, { ref: issue.ref, linkId: link.id, kind: issue.kind, details })
    }
    await this.note('no_change', { parked: issues[0]!.id })
  }

  // A delete on one side removes the other, unless that one changed since the last sync.
  private async oneOrBothGone(
    link: Link,
    invoicing: Side<N>,
    qbo: Side<N>,
    versions: Versions
  ): Promise<void> {
    const gone: System = invoicing.state === 'gone' ? 'invoicing' : 'qbo'
    const kept = other(gone)
    const side = kept === 'invoicing' ? invoicing : qbo
    if (side.state === 'gone') return this.closeDeleted(link, 'both')
    if (side.state !== 'live') {
      return this.flag(link.id, 'unsupported', { reason: side.reason, system: kept, versions })
    }
    if (side.version === storedVersion(link, kept)) {
      const fresh = await this.spec.read(this.ctx, kept, side.id)
      if (fresh.state === 'gone') return this.closeDeleted(link, 'both')
      if (fresh.state === 'live' && fresh.version === side.version) {
        const remove = this.spec.remove
        if (!remove) throw new Error(`${this.ref.entityType} cannot be deleted in ${kept}`)
        const ref = this.refOn(kept, side.id)
        await this.write({ ref, action: 'deleted' }, () => remove(this.ctx, kept, fresh))
        await this.save(link, { deletedAt: this.ctx.clock.now() })
        this.log({ linkId: link.id, target: kept }, 'deleted counterpart')
        await this.audit({ ref, action: 'deleted', details: { linkId: link.id, source: gone } })
        return
      }
    }
    return this.flag(link.id, 'conflict', {
      reason: `deleted in ${gone}, changed in ${kept}`,
      versions,
    })
  }

  private async closeDeleted(link: Link, gone: string): Promise<void> {
    await this.save(link, { deletedAt: this.ctx.clock.now() })
    await this.note('no_change', { gone })
  }

  // Opens (or refreshes) an issue on the job's record and audits it.
  private async flag(
    linkId: string | null,
    kind: IssueKind,
    details: Record<string, unknown>
  ): Promise<void> {
    const by = linkId === null ? { ref: this.ref } : { linkId }
    const known = (await openIssues(this.ctx.db, by)).some((i) => i.kind === kind)
    const issue = await openIssue(this.ctx.db, { ref: this.ref, linkId, kind, details })
    this.log({ issueId: issue.id, kind }, known ? 'issue refreshed' : 'issue opened')
    await this.note(known ? 'no_change' : 'issue_opened', { issueId: issue.id, kind })
  }

  // Runs a write; a failed one is audited with its error and rethrown.
  private async write<T>(entry: AuditEntry, run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (error) {
      await this.audit({ ...entry, error: message(error) })
      throw error
    }
  }

  private async save(link: Link, patch: Parameters<typeof updateLink>[2]): Promise<Link> {
    const saved = await updateLink(this.ctx.db, link, patch)
    if (!saved) throw new StaleError(`link ${link.id} changed underneath the job`)
    return saved
  }

  private refOn(system: System, entityId: string): RecordRef {
    return { system, entityType: this.ref.entityType, entityId }
  }

  private note(action: AuditEntry['action'], details?: object): Promise<void> {
    return this.audit({ ref: this.ref, action, details })
  }

  private audit(entry: Omit<AuditEntry, 'jobId'>): Promise<void> {
    return audit(this.ctx.db, { ...entry, jobId: this.ctx.jobId })
  }

  private log(fields: object, msg: string): void {
    this.ctx.log.info({ ...logFields(this.ctx, this.ref), ...fields }, msg)
  }
}
