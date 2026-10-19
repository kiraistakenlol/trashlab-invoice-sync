// An operator's answer to a conflict: the chosen side is written through the normal reconcile.
import type { System } from '../db/database.js'
import { audit } from '../store/audit.js'
import { getIssue, resolveIssue } from '../store/issues.js'
import { enqueue } from '../store/jobs.js'
import { getLink, updateLink } from '../store/links.js'
import type { SyncContext } from './context.js'
import { StaleError } from './errors.js'
import type { Neutral, Side } from './neutral.js'
import { specFor } from './specs/index.js'

export type ResolveOutcome =
  'resolved' | 'not_found' | 'not_open' | 'not_conflict' | 'cannot_restore'

// The loser's current state becomes the link's snapshot and stored version and the winner's
// stored version is cleared, so the next reconcile sees only the winner as changed and copies
// it. A deleted loser, or one in a final state the winner isn't in, can't take the winner's
// state.
export async function resolveConflict(
  ctx: SyncContext,
  issueId: string,
  side: System
): Promise<ResolveOutcome> {
  for (let attempt = 0; ; attempt++) {
    const outcome = await attemptResolve(ctx, issueId, side)
    if (outcome !== 'stale') return outcome
    if (attempt >= ctx.config.staleRetries) {
      throw new StaleError(`link of issue ${issueId} kept changing`)
    }
  }
}

async function attemptResolve(
  ctx: SyncContext,
  issueId: string,
  winner: System
): Promise<ResolveOutcome | 'stale'> {
  const issue = await getIssue(ctx.db, issueId)
  if (!issue) return 'not_found'
  if (issue.resolvedAt !== null) return 'not_open'
  if (issue.kind !== 'conflict' || issue.linkId === null) return 'not_conflict'
  const link = await getLink(ctx.db, issue.linkId)
  const spec = specFor(link.entityType)
  const snapshot = link.snapshot as Neutral | null
  const read = async (system: System): Promise<Side<Neutral>> => {
    const id = system === 'invoicing' ? link.invoicingId : link.qboId
    const s = await spec.read(ctx, system, id!)
    return s.state === 'live' && spec.normalize && snapshot !== null
      ? { ...s, fields: spec.normalize(s.fields, snapshot) }
      : s
  }
  const loser: System = winner === 'invoicing' ? 'qbo' : 'invoicing'
  const [won, lost] = [await read(winner), await read(loser)]
  if (lost.state !== 'live' || won.state === 'unsupported' || won.state === 'ignored') {
    return 'cannot_restore'
  }
  if (won.state === 'live' && spec.final?.(lost.fields) && !spec.final(won.fields)) {
    return 'cannot_restore'
  }

  return ctx.db.transaction().execute(async (tx) => {
    const now = ctx.clock.now()
    const saved = await updateLink(tx, link, {
      snapshot: lost.fields,
      ...(loser === 'invoicing'
        ? { invoicingVersion: Number.parseInt(lost.version, 10), qboSyncToken: null }
        : { qboSyncToken: lost.version, invoicingVersion: null }),
    })
    if (!saved) return 'stale'
    await resolveIssue(tx, issue.id, winner, now)
    await audit(tx, {
      ref: issue.ref,
      action: 'issue_resolved',
      details: { issueId: issue.id, kind: issue.kind, resolution: winner, by: 'operator' },
    })
    await enqueue(tx, issue.ref, now)
    ctx.log.info(
      { issueId: issue.id, linkId: link.id, resolution: winner, entity: link.entityType },
      'conflict resolved by operator'
    )
    return 'resolved'
  })
}
