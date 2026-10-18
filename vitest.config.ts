import { defineConfig } from 'vitest/config'

// Files named sandbox.test.ts call the real QBO sandbox; everything else runs offline.
const SANDBOX = 'test/**/sandbox.test.ts'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'offline',
          globalSetup: ['test/harness/global-setup.ts'],
          include: ['test/**/*.test.ts'],
          exclude: [SANDBOX],
        },
      },
      {
        test: {
          name: 'sandbox',
          globalSetup: ['test/harness/global-setup.ts'],
          include: [SANDBOX],
          fileParallelism: false,
          testTimeout: 180_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
})
