import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'default',
          include: ['test/**/*.test.ts'],
          exclude: ['test/e2e/**'],
        },
      },
      {
        test: {
          name: 'e2e',
          include: ['test/e2e/**/*.test.ts'],
          fileParallelism: false,
          testTimeout: 60_000,
        },
      },
    ],
  },
})
