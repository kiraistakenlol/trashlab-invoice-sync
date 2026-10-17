// Values shared between the global setup and the test workers.
export const TEMPLATE_DB = 'sync_template'

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string
  }
}
