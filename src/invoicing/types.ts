// Invoicing system entities and write inputs.
import type { Money } from '../money.js'

interface Record_ {
  id: string
  version: number
  createdAt: string
  updatedAt: string
}

export interface Account extends Record_ {
  name: string
  deactivatedAt: string | null
}

export interface Item extends Record_ {
  name: string
  incomeAccountId: string
  deactivatedAt: string | null
}

export interface Customer extends Record_ {
  name: string
  email: string | null
  deactivatedAt: string | null
}

export interface InvoiceLine {
  id: string
  itemId: string
  description: string | null
  quantity: string
  unitPrice: Money
  amount: Money
}

export type InvoiceStatus = 'open' | 'partly_paid' | 'paid' | 'void' | 'deleted'

export interface Invoice extends Record_ {
  number: string
  customerId: string
  issueDate: string
  dueDate: string
  memo: string | null
  lines: InvoiceLine[]
  tax: Money
  total: Money
  paid: Money
  balance: Money
  status: InvoiceStatus
  voidedAt: string | null
  deletedAt: string | null
}

export interface AccountInput {
  name: string
}

export interface ItemInput {
  name: string
  incomeAccountId: string
}

export interface CustomerInput {
  name: string
  email?: string | null
}

export interface InvoiceLineInput {
  id?: string
  itemId: string
  description?: string | null
  quantity: string
  unitPrice: Money
  amount: Money
}

export interface InvoiceInput {
  number?: string
  customerId: string
  issueDate: string
  dueDate: string
  memo?: string | null
  lines: InvoiceLineInput[]
  tax?: Money
}

export type InvoiceReplace = Omit<InvoiceInput, 'number'>

export type CatalogueUpdate<T> = Partial<T> & { deactivated?: boolean }
