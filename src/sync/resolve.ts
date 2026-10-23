// An operator's answer to a conflict: the chosen side is written through the normal reconcile.
import type { System } from '../db/database.js'
import { audit } from '../store/audit.js'
import { getIssue, resolveIssue, type Issue } from '../store/issues.js'
import { enqueue } from '../store/jobs.js'
import { getLink, setVersion, updateLink, type Link, type LinkPatch } from '../store/links.js'
import type { SyncContext } from './context.js'
import { otherSystem, readNormalized, type Live } from './engine.js'
import { StaleError } from './errors.js'
import type { Neutral } from './neutral.js'
import { specFor } from './specs/index.js'

export type ResolveOutcome =
  | 'resolved'
  | 'not_found'
  | 'not_open'
  | 'not_conflict'
  | 'not_paired'
  | 'blocked'
  | 'cannot_restore'

// The loser's current state becomes the link's snapshot and stored version and the winner's
// stored version is cleared, so the next reconcile sees only the winner as changed and copies
// it. A deleted loser, or one in a final state the winner isn't in, can't take the winner's
// state. A conflict over a write that can't go ahead, or over a record with no counterpart yet,
// closes only once the data is fixed.
export async function resolveConflict(
  ctx: SyncContext,
  issueId: string,
  side: System
): Promise<ResolveOutcome> {
  for (let attempt = 0; ; attempt++) {
    const outcome = await attemptResolve(ctx, issueId, side)
    if (outcome !== 'stale') {
      return outcome
    }
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
  if (!issue) {
    return 'not_found'
  }
  if (issue.resolvedAt !== null) {
    return 'not_open'
  }
  if (issue.kind !== 'conflict' || issue.linkId === null) {
    return 'not_conflict'
  }
  const link = await getLink(ctx.db, issue.linkId)
  if (link.invoicingId === null || link.qboId === null) {
    return 'not_paired'
  }
  if (issue.details.blocked === true) {
    return 'blocked'
  }
  const ids = { invoicing: link.invoicingId, qbo: link.qboId }
  const lost = await restorableLoser(ctx, link, ids, winner)
  if (!lost) {
    return 'cannot_restore'
  }
  return applyResolution(ctx, issue, link, winner, lost)
}

// The loser's current state, or null when it can't take the winner's: it is deleted, or in a
// final state the winner isn't in.
async function restorableLoser(
  ctx: SyncContext,
  link: Link,
  ids: Record<System, string>,
  winner: System
): Promise<Live<Neutral> | null> {
  const spec = specFor(link.entityType)
  const snapshot = link.snapshot as Neutral | null
  const loser = otherSystem(winner)
  const won = await readNormalized(ctx, spec, winner, ids[winner], snapshot)
  const lost = await readNormalized(ctx, spec, loser, ids[loser], snapshot)
  if (lost.state !== 'live' || won.state === 'unsupported' || won.state === 'ignored') {
    return null
  }
  if (won.state === 'live' && spec.final?.(lost.fields) && !spec.final(won.fields)) {
    return null
  }
  return lost
}

async function applyResolution(
  ctx: SyncContext,
  issue: Issue,
  link: Link,
  winner: System,
  lost: Live<Neutral>
): Promise<ResolveOutcome | 'stale'> {
  const now = ctx.clock.now()
  const patch: LinkPatch = { snapshot: lost.fields }
  setVersion(patch, otherSystem(winner), lost.version)
  setVersion(patch, winner, null)
  try {
    return await ctx.db.transaction().execute(async (tx) => {
      if (!(await resolveIssue(tx, issue.id, winner, now))) {
        return 'not_open'
      }
      // rolls back the resolution
      if (!(await updateLink(tx, link, patch))) {
        throw new StaleError(`link ${link.id} changed`)
      }
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
  } catch (error) {
    if (error instanceof StaleError) {
      return 'stale'
    }
    throw error
  }
}
