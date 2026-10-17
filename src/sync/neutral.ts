// The neutral form both systems map to; every reference is a link id.
import type { EntityType } from '../db/database.js'
import type { Money } from '../money.js'

export interface NeutralAccount {
  name: string
  active: boolean
}

export interface NeutralItem {
  name: string
  incomeAccount: string
  active: boolean
}

export interface NeutralCustomer {
  name: string
  active: boolean
}

export interface NeutralLine {
  item: string
  description: string | null
  quantity: string
  unitPrice: Money
  amount: Money
}

export interface NeutralInvoice {
  number: string
  customer: string
  issueDate: string
  dueDate: string
  memo: string | null
  lines: NeutralLine[]
  tax: Money
  voided: boolean
}

export interface NeutralPayment {
  customer: string
  date: string
  amount: Money
  allocations: { invoice: string; amount: Money }[] // sorted by invoice
}

export type Neutral =
  NeutralAccount | NeutralItem | NeutralCustomer | NeutralInvoice | NeutralPayment

// version is the invoicing version or the QBO SyncToken; 'unsupported' opens an issue,
// 'ignored' is only audited
export type Side<N> =
  | { state: 'live'; id: string; version: string; fields: N }
  | { state: 'gone' }
  | { state: 'unsupported' | 'ignored'; id: string; reason: string }

// side id -> link id, and link id -> this side's id; the caller has ensured the link exists
export type ToLink = (entityType: EntityType, id: string) => string
export type ToSide = (linkId: string) => string

export const sortAllocations = (
  allocations: NeutralPayment['allocations']
): NeutralPayment['allocations'] =>
  [...allocations].sort((a, b) => (a.invoice < b.invoice ? -1 : a.invoice > b.invoice ? 1 : 0))
