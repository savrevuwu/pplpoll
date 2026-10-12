import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'domain', include: ['packages/domain/test/**/*.test.ts'] } },
      { test: { name: 'api-unit', include: ['apps/api/test/unit/**/*.test.ts'] } },
      {
        test: {
          name: 'integration',
          include: ['packages/db/test/**/*.test.ts', 'apps/api/test/integration/**/*.test.ts'],
          // Integration tests share one database; run files one at a time.
          fileParallelism: false,
        },
      },
    ],
  },
});
