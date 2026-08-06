import { fileURLToPath } from 'node:url';

import { configDefaults, defineConfig } from 'vitest/config';

import { createDecoratorsPlugin } from '../../tooling/vite/decorators';

export default defineConfig({
  plugins: [createDecoratorsPlugin()],
  test: {
    environment: 'node',
    globals: false,
    clearMocks: true,
    setupFiles: ['test/network-deny.setup.ts'],
    include: ['test/**/*.process.test.ts'],
    exclude: [...configDefaults.exclude],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    teardownTimeout: 30_000,
  },
  resolve: {
    alias: {
      '@ruixutong.manee/maneeagent-framework': fileURLToPath(
        new URL('../core/src/index.ts', import.meta.url),
      ),
    },
  },
});
