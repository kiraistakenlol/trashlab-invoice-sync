// The entity spec for each synced entity type.
import type { EntityType } from '../../db/database.js'
import type { EntitySpec } from '../engine.js'
import type { Neutral } from '../neutral.js'
import { accountSpec, customerSpec, itemSpec } from './catalogue.js'
import { invoiceSpec } from './invoice.js'

// resolved at call time, which keeps the import cycle through the engine safe
export function specFor(entityType: EntityType): EntitySpec<Neutral> {
  switch (entityType) {
    case 'account':
      return accountSpec as EntitySpec<Neutral>
    case 'item':
      return itemSpec as EntitySpec<Neutral>
    case 'customer':
      return customerSpec as EntitySpec<Neutral>
    case 'invoice':
      return invoiceSpec as EntitySpec<Neutral>
    default:
      throw new Error(`${entityType} is not synced`)
  }
}
