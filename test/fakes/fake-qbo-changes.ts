// The fake QBO's change log: one entry per applied write, in write order.
import type { QboEntityName } from '../../src/qbo/entities.js'
import type { QboWebhookEntity } from '../../src/qbo/webhooks.js'

export type Operation = 'Create' | 'Update' | 'Void' | 'Delete'

export interface Change {
  entity: QboEntityName
  id: string
  operation: Operation
  time: Date
}

export class QboChanges {
  private readonly log: Change[] = []
  private delivered = 0

  record(change: Change): void {
    this.log.push(change)
  }

  deletions(entity: QboEntityName): Change[] {
    return this.log.filter((c) => c.entity === entity && c.operation === 'Delete')
  }

  // Returns and clears the events not yet delivered, as a lossy, unordered webhook channel would
  takeWebhooks(
    opts: {
      duplicate?: boolean
      reverse?: boolean
      drop?: (e: QboWebhookEntity) => boolean
    } = {}
  ): QboWebhookEntity[] {
    let out = this.log.slice(this.delivered).map((c): QboWebhookEntity => ({
      name: c.entity,
      id: c.id,
      operation: c.operation,
      lastUpdated: c.time.toISOString(),
    }))
    this.delivered = this.log.length
    if (opts.drop) {
      out = out.filter((e) => !opts.drop!(e))
    }
    if (opts.duplicate) {
      out = out.flatMap((e) => [e, { ...e }])
    }
    if (opts.reverse) {
      out.reverse()
    }
    return out
  }
}
