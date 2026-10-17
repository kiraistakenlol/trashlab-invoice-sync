// The fake QBO's payment ledger: how payments apply to invoices and what invoices owe.
import type { QboPayment } from '../../src/qbo/entities.js'
import { add, cmp, isZero, min, sub, toMoney, type Money } from '../../src/money.js'
import { Fault, type Body, type QboRecords, type Rec } from './fake-qbo-records.js'

type Line = Record<string, unknown>
type PaymentLine = QboPayment['Line'][number]

const ZERO: Money = '0.00'

export class PaymentLedger {
  constructor(private readonly records: QboRecords) {}

  // A payment's customer, amount and lines as stored: each line applied to one invoice of the
  // customer, clipped to that invoice's open balance; what is not applied stays unapplied.
  payment(id: string, body: Body): Body {
    const CustomerRef = this.records.customerRef(body.CustomerRef)
    if (body.TotalAmt === undefined || body.TotalAmt === null) {
      throw new Fault('6000', "The Amount Received (plus credits) can't be less than the charges")
    }
    const total = toMoney(body.TotalAmt as number)
    if (cmp(total, ZERO) < 0) throw new Fault('2240', 'Number out of range', 'TotalAmt')
    if (isZero(total)) throw new Fault('6000', 'Enter a transaction amount')
    const sent = (body.Line ?? []) as Line[]
    if (cmp(add(...sent.map((l) => toMoney(l.Amount as number))), total) > 0) {
      throw new Fault('6000', "The Amount Received (plus credits) can't be less than the charges")
    }
    const Line = sent.flatMap((l): PaymentLine[] => {
      const txns = (l.LinkedTxn ?? []) as PaymentLine['LinkedTxn']
      if (txns.length !== 1) return [] // a line linking several invoices applies to none
      const invoice = this.records.find('Invoice', txns[0].TxnId)
      if ((invoice.CustomerRef as { value: string }).value !== CustomerRef.value) {
        throw new Fault('620', 'TxnID Cannot Be Linked')
      }
      const amount = min(toMoney(l.Amount as number), this.balance(invoice, id))
      if (cmp(amount, ZERO) <= 0) return []
      return [{ Amount: Number(amount), LinkedTxn: [{ TxnId: invoice.Id, TxnType: 'Invoice' }] }]
    })
    return { CustomerRef, TotalAmt: Number(total), Line }
  }

  // The amounts applied to an invoice, by payment, in payment order.
  applications(invoiceId: string): { payment: Rec; amount: Money }[] {
    return this.records
      .all('Payment')
      .flatMap((payment) =>
        (payment.Line as PaymentLine[])
          .filter((l) => l.LinkedTxn[0].TxnId === invoiceId)
          .map((l) => ({ payment, amount: toMoney(l.Amount) }))
      )
  }

  unapplied(payment: Rec): Money {
    const applied = add(...(payment.Line as PaymentLine[]).map((l) => toMoney(l.Amount)))
    return sub(toMoney(payment.TotalAmt as number), applied)
  }

  subtotal(invoice: Rec): Money {
    return add(...(invoice.Line as Line[]).map((l) => toMoney(l.Amount as number)))
  }

  total(invoice: Rec): Money {
    const tax = (invoice.TxnTaxDetail as { TotalTax: number } | undefined)?.TotalTax ?? 0
    return add(this.subtotal(invoice), toMoney(tax))
  }

  balance(invoice: Rec, exceptPaymentId?: string): Money {
    const paid = this.applications(invoice.Id)
      .filter((a) => a.payment.Id !== exceptPaymentId)
      .map((a) => a.amount)
    return sub(this.total(invoice), add(...paid))
  }

  // Saves, and so bumps the SyncToken of, every invoice whose applied amount a payment write
  // changed.
  bumpInvoices(before: unknown, after: unknown): void {
    const applied = (lines: unknown) =>
      new Map((lines as PaymentLine[]).map((l) => [l.LinkedTxn[0].TxnId, toMoney(l.Amount)]))
    const [was, now] = [applied(before), applied(after)]
    for (const id of new Set([...was.keys(), ...now.keys()])) {
      const invoice = this.records.get('Invoice', id)
      if (invoice && was.get(id) !== now.get(id)) this.records.save('Invoice', invoice)
    }
  }

  // Shrinks the payments applied to an invoice, in payment order, to fit within `cap` (by
  // default nothing); the rest of each becomes unapplied.
  refit(invoiceId: string, cap: Money = ZERO): void {
    let left = cap
    for (const { payment, amount } of this.applications(invoiceId)) {
      const keep = min(amount, left)
      left = sub(left, keep)
      if (keep === amount) continue
      const Line = (payment.Line as PaymentLine[]).flatMap((l) => {
        if (l.LinkedTxn[0].TxnId !== invoiceId) return [l]
        return isZero(keep) ? [] : [{ ...l, Amount: Number(keep) }]
      })
      this.records.save('Payment', { ...payment, Line })
    }
  }
}
