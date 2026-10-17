// Failed and lost writes while creating invoices (SCENARIOS.md R1-R5) and racing jobs.
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { Invoice } from '../../src/invoicing/types.js'
import type { System } from '../../src/db/database.js'
import type { SyncConfig } from '../../src/sync/context.js'
import { reconcile } from '../../src/sync/engine.js'
import { notify } from '../../src/sync/intake.js'
import type { QboFailure } from '../fakes/fake-qbo.js'
import { createWorld, type World } from '../harness/world.js'
import {
  DUE_DATE,
  invoicingEvents,
  ISSUE_DATE,
  linkedCustomer,
  linkedItem,
  qboEvents,
} from './given.js'

const PAST_BACKOFF_MS = 1_000
const TIMEOUT = expect.stringMatching(/timeout/)

let w: World
afterEach(() => w.close())

async function given(config?: Partial<SyncConfig>) {
  w = await createWorld({ config })
  const { customer, qboId: customerQboId } = await linkedCustomer(w, 'Acme')
  const { item, qboId: itemQboId } = await linkedItem(w, 'Pickup', 'Hauling')
  return { customer, customerQboId, item, itemQboId }
}

const createInvoice = (customerId: string, itemId: string): Promise<Invoice> =>
  w.invoicing.createInvoice(
    {
      customerId,
      issueDate: ISSUE_DATE,
      dueDate: DUE_DATE,
      lines: [{ itemId, quantity: '1', unitPrice: '80.00', amount: '80.00' }],
    },
    randomUUID()
  )

const jobStatuses = async () =>
  (await w.db.selectFrom('sync_jobs').select(['entity_type', 'status']).execute()).filter(
    (j) => j.entity_type === 'invoice'
  )

const jobOf = (system: System, id: string) =>
  w.db
    .selectFrom('sync_jobs')
    .select(['status', 'attempts', 'last_error'])
    .where('system', '=', system)
    .where('entity_type', '=', 'invoice')
    .where('entity_id', '=', id)
    .executeTakeFirstOrThrow()

const actions = async (system: 'invoicing' | 'qbo', id: string) =>
  (await w.history(system, 'invoice', id)).map((e) => e.action)

// a failed create is audited on the record being copied, a successful one on the copy
const createdErrors = async (system: 'invoicing' | 'qbo', id: string) =>
  (await w.history(system, 'invoice', id)).filter((e) => e.action === 'created').map((e) => e.error)

describe('R1 timeout after a write to QBO', () => {
  it('retries under the same key and gets the same QBO invoice back', async () => {
    // Given
    const { customer, item } = await given()
    w.qbo.failNext({ method: 'POST', path: '/invoice' }, 'timeout_after_write')
    const invoice = await createInvoice(customer.id, item.id)
    // When the response is lost, and QBO's notification of the new invoice with it
    await w.deliver()
    await w.drain()
    await w.deliver({ drop: qboEvents })
    w.clock.advance(PAST_BACKOFF_MS)
    await w.sync()
    // Then
    const [qboInvoice, ...more] = await w.ctx.qbo.findInvoicesByNumber(invoice.number)
    expect(more).toEqual([])
    expect(await w.linkOf('invoice', 'invoicing', invoice.id)).toMatchObject({
      qboId: qboInvoice!.Id,
    })
    expect(await createdErrors('invoicing', invoice.id)).toEqual([TIMEOUT])
    expect(await createdErrors('qbo', qboInvoice!.Id)).toEqual([null])
    expect(await actions('qbo', qboInvoice!.Id)).not.toContain('linked') // replayed, not adopted
    expect(await w.issues()).toEqual([])
  })

  it('reuses the key when the retry comes from a new job', async () => {
    // Given
    const { customer, item } = await given({ maxAttempts: 1 })
    w.qbo.failNext({ method: 'POST', path: '/invoice' }, 'timeout_after_write')
    const invoice = await createInvoice(customer.id, item.id)
    await w.deliver()
    await w.drain()
    await w.deliver({ drop: qboEvents })
    expect(await jobStatuses()).toEqual([{ entity_type: 'invoice', status: 'failed' }])
    // When
    await notify(
      w.ctx,
      { system: 'invoicing', entityType: 'invoice', entityId: invoice.id },
      { reason: 'operator retry' }
    )
    await w.sync()
    // Then
    const [qboInvoice, ...more] = await w.ctx.qbo.findInvoicesByNumber(invoice.number)
    expect(more).toEqual([])
    expect(await w.linkOf('invoice', 'invoicing', invoice.id)).toMatchObject({
      qboId: qboInvoice!.Id,
    })
    expect(await createdErrors('invoicing', invoice.id)).toEqual([TIMEOUT])
    expect(await createdErrors('qbo', qboInvoice!.Id)).toEqual([null])
    expect(await actions('qbo', qboInvoice!.Id)).not.toContain('linked') // replayed, not adopted
    expect(await w.issues()).toEqual([])
  })
})

describe('R2 timeout after a write to invoicing', () => {
  it('retries under the same key and gets the same invoice back', async () => {
    // Given
    const { customerQboId, itemQboId } = await given()
    w.invoicing.failNext('createInvoice', 'timeout_after_write')
    const qboInvoice = await w.qboActor.createInvoice(customerQboId, [
      { amount: '25.00', itemId: itemQboId },
    ])
    // When the response is lost, and invoicing's notification of the new invoice with it
    await w.deliver()
    await w.drain()
    await w.deliver({ drop: invoicingEvents('invoice') })
    w.clock.advance(PAST_BACKOFF_MS)
    await w.sync()
    // Then
    const [invoice, ...more] = await w.invoicing.listInvoices({ number: qboInvoice.DocNumber })
    expect(more).toEqual([])
    expect(await w.linkOf('invoice', 'qbo', qboInvoice.Id)).toMatchObject({
      invoicingId: invoice!.id,
    })
    expect(await createdErrors('qbo', qboInvoice.Id)).toEqual([TIMEOUT])
    expect(await createdErrors('invoicing', invoice!.id)).toEqual([null])
    expect(await w.issues()).toEqual([])
  })
})

describe('R3 transient failures are retried', () => {
  it.each<QboFailure>(['http_500', 'http_429', 'timeout_before_write'])(
    'retries a create that QBO answers with %s',
    async (failure) => {
      // Given
      const { customer, item } = await given()
      w.qbo.failNext({ method: 'POST', path: '/invoice' }, failure)
      const invoice = await createInvoice(customer.id, item.id)
      // When
      await w.sync()
      // Then it waits for its retry
      expect(await jobOf('invoicing', invoice.id)).toMatchObject({
        status: 'pending',
        attempts: 1,
        last_error: expect.any(String),
      })
      expect(await w.ctx.qbo.findInvoicesByNumber(invoice.number)).toEqual([])
      // When
      w.clock.advance(PAST_BACKOFF_MS)
      await w.sync()
      // Then
      const [qboInvoice, ...more] = await w.ctx.qbo.findInvoicesByNumber(invoice.number)
      expect(more).toEqual([])
      expect(await w.linkOf('invoice', 'invoicing', invoice.id)).toMatchObject({
        qboId: qboInvoice!.Id,
      })
      expect(await jobOf('invoicing', invoice.id)).toMatchObject({ status: 'done', attempts: 2 })
      expect(await createdErrors('invoicing', invoice.id)).toEqual([expect.any(String)])
      expect(await createdErrors('qbo', qboInvoice!.Id)).toEqual([null])
      expect(await w.issues()).toEqual([])
    }
  )

  it('retries a create that invoicing answers with unavailable', async () => {
    // Given
    const { customerQboId, itemQboId } = await given()
    w.invoicing.failNext('createInvoice', 'unavailable')
    const qboInvoice = await w.qboActor.createInvoice(customerQboId, [
      { amount: '25.00', itemId: itemQboId },
    ])
    // When
    await w.sync()
    // Then it waits for its retry
    expect(await jobOf('qbo', qboInvoice.Id)).toMatchObject({
      status: 'pending',
      attempts: 1,
      last_error: expect.any(String),
    })
    expect(await w.invoicing.listInvoices({ number: qboInvoice.DocNumber })).toEqual([])
    // When
    w.clock.advance(PAST_BACKOFF_MS)
    await w.sync()
    // Then
    const [invoice, ...more] = await w.invoicing.listInvoices({ number: qboInvoice.DocNumber })
    expect(more).toEqual([])
    expect(await w.linkOf('invoice', 'qbo', qboInvoice.Id)).toMatchObject({
      invoicingId: invoice!.id,
    })
    expect(await jobOf('qbo', qboInvoice.Id)).toMatchObject({ status: 'done', attempts: 2 })
    expect(await createdErrors('qbo', qboInvoice.Id)).toEqual([expect.any(String)])
    expect(await createdErrors('invoicing', invoice!.id)).toEqual([null])
    expect(await w.issues()).toEqual([])
  })
})

describe('R4 permanent failures are not retried', () => {
  it('fails the job on a QBO validation error and leaves it failed', async () => {
    // Given
    const { customer, item } = await given()
    w.qbo.failNext({ method: 'POST', path: '/invoice' }, 'http_400')
    const invoice = await createInvoice(customer.id, item.id)
    // When
    await w.sync()
    w.clock.advance(PAST_BACKOFF_MS)
    await w.sync()
    // Then
    expect(await jobOf('invoicing', invoice.id)).toEqual({
      status: 'failed',
      attempts: 1,
      last_error: expect.stringMatching(/2050/),
    })
    expect(await w.ctx.qbo.findInvoicesByNumber(invoice.number)).toEqual([])
    expect(await createdErrors('invoicing', invoice.id)).toEqual([expect.stringMatching(/2050/)])
  })

  it('shows a job that failed on a read, before any write, in the read API', async () => {
    // Given
    const { customerQboId, itemQboId } = await given()
    w.qbo.failNext({ method: 'GET', path: '/invoice/' }, 'http_400')
    const qboInvoice = await w.qboActor.createInvoice(customerQboId, [
      { itemId: itemQboId, amount: '80.00' },
    ])
    // When
    await w.sync()
    // Then
    const res = await w.server.inject({ method: 'GET', url: '/jobs?status=failed' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      data: [
        {
          id: expect.any(String),
          system: 'qbo',
          entityType: 'invoice',
          entityId: qboInvoice.Id,
          status: 'failed',
          attempts: 1,
          lastError: expect.stringMatching(/2050/),
          runAfter: expect.any(String),
          updatedAt: expect.any(String),
        },
      ],
    })
  })
})

describe('R5 retry after partial success', () => {
  it('creates the customer once and the invoice on the retry', async () => {
    // Given
    w = await createWorld()
    const { item } = await linkedItem(w, 'Pickup', 'Hauling')
    const customer = await w.invoicing.createCustomer({ name: 'Hauler Co' }, randomUUID())
    w.qbo.failNext({ method: 'POST', path: '/invoice' }, 'http_500')
    const invoice = await createInvoice(customer.id, item.id)
    // When
    await w.deliver({ drop: invoicingEvents('customer') })
    await w.drain()
    w.clock.advance(PAST_BACKOFF_MS)
    await w.sync()
    // Then
    const [qboCustomer, ...moreCustomers] = await w.ctx.qbo.findByName('Customer', 'Hauler Co')
    expect(moreCustomers).toEqual([])
    expect((await w.history('qbo', 'customer', qboCustomer!.Id)).map((e) => e.action)).toContain(
      'created'
    )
    const [qboInvoice, ...more] = await w.ctx.qbo.findInvoicesByNumber(invoice.number)
    expect(more).toEqual([])
    expect(qboInvoice).toMatchObject({ CustomerRef: { value: qboCustomer!.Id } })
    expect(await createdErrors('invoicing', invoice.id)).toEqual([expect.any(String)])
    expect(await createdErrors('qbo', qboInvoice!.Id)).toEqual([null])
    expect(await w.issues()).toEqual([])
  })
})

describe("both sides' jobs race on a new invoice", () => {
  it('ends with one link and one invoice on each side', async () => {
    // Given
    const { customer, item } = await given()
    const invoice = await createInvoice(customer.id, item.id)
    let raced: string | undefined
    // When QBO's job for the new invoice runs before the creating job stores the link
    w.hook(
      'qbo',
      { method: 'POST', path: '/invoice' },
      async () => {
        const [created] = await w.ctx.qbo.findInvoicesByNumber(invoice.number)
        raced = created!.Id
        await reconcile(w.ctx, { system: 'qbo', entityType: 'invoice', entityId: raced })
      },
      'after'
    )
    await w.sync()
    // Then
    expect(raced).toBeDefined()
    expect(await w.ctx.qbo.findInvoicesByNumber(invoice.number)).toHaveLength(1)
    expect(await w.invoicing.listInvoices({ number: invoice.number })).toHaveLength(1)
    const links = await w.db
      .selectFrom('invoicing_qbo_links')
      .select(['invoicing_id', 'qbo_id'])
      .where('entity_type', '=', 'invoice')
      .execute()
    expect(links).toEqual([{ invoicing_id: invoice.id, qbo_id: raced }])
    expect(await w.history('qbo', 'invoice', raced!)).toContainEqual(
      expect.objectContaining({
        action: 'linked',
        details: expect.objectContaining({ adopted: true }),
      })
    )
    expect(await w.issues()).toEqual([])
  })
})
