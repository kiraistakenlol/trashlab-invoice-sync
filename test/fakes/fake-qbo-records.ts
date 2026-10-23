// The fake QBO's record store: records by entity, stamped with SyncToken and MetaData.
import type { QboEntityName, QboRef } from '../../src/qbo/entities.js'

export type Body = Record<string, unknown>
export type Rec = Body & { Id: string; SyncToken: string }

export const ENTITIES: QboEntityName[] = ['Customer', 'Account', 'Item', 'Invoice', 'Payment']
const COMPANY_OFFSET_HOURS = -7

export class Fault {
  constructor(
    readonly code: string,
    readonly message: string,
    readonly element = ''
  ) {}
}

export const ref = (value: string, name?: unknown): QboRef => ({
  value,
  ...(name ? { name: String(name) } : {}),
})

// QBO renders timestamps in the company's time zone, at whole seconds
export const qboTime = (d: Date): string => {
  const shifted = new Date(d.getTime() + COMPANY_OFFSET_HOURS * 3_600_000)
  const sign = COMPANY_OFFSET_HOURS < 0 ? '-' : '+'
  const hh = String(Math.abs(COMPANY_OFFSET_HOURS)).padStart(2, '0')
  return `${shifted.toISOString().slice(0, 19)}${sign}${hh}:00`
}

export class QboRecords {
  private readonly store = new Map<QboEntityName, Map<string, Rec>>(
    ENTITIES.map((e) => [e, new Map()])
  )

  constructor(private readonly now: () => Date) {}

  get(entity: QboEntityName, id: string): Rec | undefined {
    return this.store.get(entity)!.get(id)
  }

  find(entity: QboEntityName, id: string): Rec {
    const rec = this.get(entity, id)
    if (!rec) {
      throw new Fault('610', 'Object Not Found')
    }
    return rec
  }

  all(entity: QboEntityName): Rec[] {
    return [...this.store.get(entity)!.values()]
  }

  // Stores a record, bumping SyncToken and LastUpdatedTime when it already exists.
  save(entity: QboEntityName, rec: Body & { Id: string }): Rec {
    const now = qboTime(this.now())
    const prev = this.get(entity, rec.Id)
    const SyncToken = prev ? String(Number(prev.SyncToken) + 1) : '0'
    const CreateTime = prev ? (prev.MetaData as { CreateTime: string }).CreateTime : now
    const saved: Rec = {
      ...rec,
      SyncToken,
      domain: 'QBO',
      sparse: false,
      MetaData: { CreateTime, LastUpdatedTime: now },
    }
    this.store.get(entity)!.set(rec.Id, saved)
    return saved
  }

  delete(entity: QboEntityName, id: string): void {
    this.store.get(entity)!.delete(id)
  }

  customerRef(value: unknown): QboRef {
    const id = (value as { value?: string } | undefined)?.value ?? ''
    const customer = this.get('Customer', id)
    if (!customer) {
      throw new Fault('2500', 'Invalid Reference Id', 'CustomerRef')
    }
    return ref(id, customer.DisplayName)
  }
}
