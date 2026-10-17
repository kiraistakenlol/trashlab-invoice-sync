// The invoicing system's API as the sync consumes it.
import type {
  Account,
  AccountInput,
  CatalogueUpdate,
  Customer,
  CustomerInput,
  Invoice,
  InvoiceInput,
  InvoiceReplace,
  Item,
  ItemInput,
} from './types.js'

export interface InvoicingClient {
  getAccount(id: string): Promise<Account | null>
  listAccounts(): Promise<Account[]>
  createAccount(input: AccountInput, idempotencyKey: string): Promise<Account>
  updateAccount(id: string, patch: CatalogueUpdate<AccountInput>, version: number): Promise<Account>

  getItem(id: string): Promise<Item | null>
  listItems(): Promise<Item[]>
  createItem(input: ItemInput, idempotencyKey: string): Promise<Item>
  updateItem(id: string, patch: CatalogueUpdate<ItemInput>, version: number): Promise<Item>

  getCustomer(id: string): Promise<Customer | null>
  listCustomers(): Promise<Customer[]>
  createCustomer(input: CustomerInput, idempotencyKey: string): Promise<Customer>
  updateCustomer(
    id: string,
    patch: CatalogueUpdate<CustomerInput>,
    version: number
  ): Promise<Customer>

  getInvoice(id: string): Promise<Invoice | null>
  listInvoices(filter?: { customerId?: string; number?: string }): Promise<Invoice[]>
  createInvoice(input: InvoiceInput, idempotencyKey: string): Promise<Invoice>
  replaceInvoice(id: string, input: InvoiceReplace, version: number): Promise<Invoice>
  voidInvoice(id: string, version: number): Promise<Invoice>
  deleteInvoice(id: string, version: number): Promise<Invoice>
}
