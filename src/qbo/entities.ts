// QBO JSON types: the subset of entity and envelope fields the sync reads or writes.

export interface QboRef {
  value: string
  name?: string
}

export interface QboMetaData {
  CreateTime: string
  LastUpdatedTime: string
}

export const QBO_ENTITY_NAMES = ['Account', 'Item', 'Customer', 'Invoice', 'Payment'] as const
export type QboEntityName = (typeof QBO_ENTITY_NAMES)[number]

export interface QboCustomer {
  Id: string
  SyncToken: string
  DisplayName: string
  Active: boolean
  MetaData: QboMetaData
}

export interface QboAccount {
  Id: string
  SyncToken: string
  Name: string
  AccountType: string
  Active: boolean
  MetaData: QboMetaData
}

export interface QboItem {
  Id: string
  SyncToken: string
  Name: string
  Type: 'Service' | 'Inventory' | 'NonInventory'
  IncomeAccountRef?: QboRef
  Active: boolean
  MetaData: QboMetaData
}

export interface QboSalesLine {
  Id?: string
  LineNum?: number
  Amount: number
  Description?: string
  DetailType: 'SalesItemLineDetail'
  SalesItemLineDetail: {
    ItemRef: QboRef
    Qty?: number
    UnitPrice?: number
    TaxCodeRef?: QboRef
  }
}

export interface QboOtherLine {
  Id?: string
  Amount: number
  Description?: string
  DetailType: 'SubTotalLineDetail' | 'DescriptionOnly' | 'DiscountLineDetail'
}

export type QboInvoiceLine = QboSalesLine | QboOtherLine

export interface QboInvoice {
  Id: string
  SyncToken: string
  DocNumber?: string
  CustomerRef: QboRef
  TxnDate: string
  DueDate?: string
  CustomerMemo?: { value: string }
  PrivateNote?: string
  CurrencyRef: QboRef
  Line: QboInvoiceLine[]
  TxnTaxDetail?: { TxnTaxCodeRef?: QboRef; TotalTax: number }
  TotalAmt: number
  Balance: number
  LinkedTxn: { TxnId: string; TxnType: string }[]
  MetaData: QboMetaData
}

export interface QboPayment {
  Id: string
  SyncToken: string
  CustomerRef: QboRef
  TotalAmt: number
  TxnDate: string
  UnappliedAmt: number
  PrivateNote?: string
  DepositToAccountRef?: QboRef
  Line: { Amount: number; LinkedTxn: { TxnId: string; TxnType: 'Invoice' }[] }[]
  MetaData: QboMetaData
}

export interface QboDeletedStub {
  domain: 'QBO'
  status: 'Deleted'
  Id: string
  MetaData?: { LastUpdatedTime: string }
}

export interface QboFault {
  Fault: {
    Error: { Message: string; Detail?: string; code: string; element?: string }[]
    type: string
  }
  time: string
}
