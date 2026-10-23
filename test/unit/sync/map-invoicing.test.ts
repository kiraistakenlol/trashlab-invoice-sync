import { describe, expect, it } from 'vitest'
import {
  fromInvoicingAccount,
  fromInvoicingCustomer,
  fromInvoicingInvoice,
  fromInvoicingItem,
  fromInvoicingPayment,
  toInvoicingAccount,
  toInvoicingAccountPatch,
  toInvoicingCustomer,
  toInvoicingCustomerPatch,
  toInvoicingInvoice,
  toInvoicingItem,
  toInvoicingItemPatch,
  toInvoicingPayment,
} from '../../../src/sync/map-invoicing.js'
import type { Invoice, Payment } from '../../../src/invoicing/types.js'

const toLink = (type: string, id: string) => `${type}-link-${id}`
const toSide = (linkId: string) => linkId.split('-link-')[1]!

const rec = { version: 1, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }

const invoice: Invoice = {
  ...rec,
  id: 'i1',
  number: 'INV-1',
  customerId: 'c1',
  issueDate: '2026-01-01',
  dueDate: '2026-01-31',
  memo: 'thanks',
  lines: [
    {
      id: 'l1',
      itemId: 'it1',
      description: 'Pickup',
      quantity: '2.50',
      unitPrice: '10.00',
      amount: '25.00',
    },
    {
      id: 'l2',
      itemId: 'it2',
      description: null,
      quantity: '1',
      unitPrice: '5.00',
      amount: '5.00',
    },
  ],
  tax: '1.50',
  total: '31.50',
  paid: '0.00',
  balance: '31.50',
  status: 'open',
  voidedAt: null,
  deletedAt: null,
}

describe('invoicing mapper', () => {
  it('round-trips an account', () => {
    const a = { ...rec, id: 'a1', name: 'Sales', deactivatedAt: null }
    const n = fromInvoicingAccount(a)
    expect(n).toEqual({ name: 'Sales', active: true })
    expect(toInvoicingAccount(n)).toEqual({ name: 'Sales' })
  })

  it('round-trips an item with its income account', () => {
    const i = { ...rec, id: 'it1', name: 'Pickup', incomeAccountId: 'a1', deactivatedAt: null }
    const n = fromInvoicingItem(i, toLink)
    expect(n).toEqual({ name: 'Pickup', incomeAccount: 'account-link-a1', active: true })
    expect(toInvoicingItem(n, toSide)).toEqual({ name: 'Pickup', incomeAccountId: 'a1' })
  })

  it('maps a deactivated customer to inactive and sends the name only', () => {
    const c = {
      ...rec,
      id: 'c1',
      name: 'Acme',
      email: 'a@x.com',
      deactivatedAt: '2026-02-01T00:00:00Z',
    }
    const n = fromInvoicingCustomer(c)
    expect(n).toEqual({ name: 'Acme', active: false })
    expect(toInvoicingCustomer(n)).toEqual({ name: 'Acme' })
  })

  it('round-trips an invoice, normalising quantities', () => {
    const n = fromInvoicingInvoice(invoice, toLink)
    expect(n.customer).toBe('customer-link-c1')
    expect(n.lines[0]).toEqual({
      item: 'item-link-it1',
      description: 'Pickup',
      quantity: '2.5',
      unitPrice: '10.00',
      amount: '25.00',
    })
    expect(n.voided).toBe(false)
    const back = toInvoicingInvoice(n, toSide, invoice)
    expect(back.number).toBe('INV-1')
    expect(back.customerId).toBe('c1')
    expect(back.tax).toBe('1.50')
    expect(back.lines.map((l) => [l.id, l.itemId, l.quantity])).toEqual([
      ['l1', 'it1', '2.5'],
      ['l2', 'it2', '1'],
    ])
  })

  it('maps an empty memo to no memo', () => {
    expect(fromInvoicingInvoice({ ...invoice, memo: '' }, toLink).memo).toBeNull()
  })

  it('maps a void invoice to voided', () => {
    expect(fromInvoicingInvoice({ ...invoice, status: 'void' }, toLink).voided).toBe(true)
  })

  it('leaves line ids out without a current invoice and for lines beyond it', () => {
    const n = fromInvoicingInvoice(invoice, toLink)
    expect(toInvoicingInvoice(n, toSide).lines.every((l) => !('id' in l))).toBe(true)
    const longer = { ...n, lines: [...n.lines, n.lines[1]!] }
    const lines = toInvoicingInvoice(longer, toSide, invoice).lines
    expect(lines.map((l) => l.id)).toEqual(['l1', 'l2', undefined])
    expect('id' in lines[2]!).toBe(false)
  })

  it('sorts payment allocations by invoice link id and round-trips', () => {
    const p: Payment = {
      ...rec,
      id: 'p1',
      customerId: 'c1',
      amount: '30.00',
      date: '2026-02-01',
      allocations: [
        { invoiceId: 'i2', amount: '10.00' },
        { invoiceId: 'i1', amount: '20.00' },
      ],
      unapplied: '0.00',
      deletedAt: null,
    }
    const n = fromInvoicingPayment(p, toLink)
    expect(n.allocations.map((a) => a.invoice)).toEqual(['invoice-link-i1', 'invoice-link-i2'])
    expect(toInvoicingPayment(n, toSide)).toEqual({
      customerId: 'c1',
      amount: '30.00',
      date: '2026-02-01',
      allocations: [
        { invoiceId: 'i1', amount: '20.00' },
        { invoiceId: 'i2', amount: '10.00' },
      ],
    })
  })

  it('builds catalogue patches for the changed keys only', () => {
    expect(toInvoicingAccountPatch({ name: 'X' })).toEqual({ name: 'X' })
    expect(toInvoicingCustomerPatch({ active: false })).toEqual({ deactivated: true })
    expect(
      toInvoicingItemPatch({ incomeAccount: 'account-link-a2', active: true }, toSide)
    ).toEqual({ incomeAccountId: 'a2', deactivated: false })
  })
})
