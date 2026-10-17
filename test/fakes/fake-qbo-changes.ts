// The fake QBO's change log: one entry per applied write, in write order.
import type { QboEntityName } from '../../src/qbo/entities.js'

export type Operation = 'Create' | 'Update' | 'Void' | 'Delete'

export interface Change {
  entity: QboEntityName
  id: string
  operation: Operation
  time: Date
}

export class QboChanges {
  private readonly log: Change[] = []

  record(change: Change): void {
    this.log.push(change)
  }
}
