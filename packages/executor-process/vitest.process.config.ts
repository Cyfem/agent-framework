import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

import { createDecoratorsPlugin } from '../../tooling/vite/decorators';

export default defineConfig({
  plugins: [createDecoratorsPlugin()],
  test: {
    environment: 'node',
    globals: false,
    clearMocks: true,
    fileParallelism: false,
    include: ['test/**/*.process.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    setupFiles: ['test/network-deny.setup.ts'],
  },
  resolve: {
    alias: {
      '@ruixutong.manee/maneeagent-framework': fileURLToPath(
        new URL('../core/src/index.ts', import.meta.url),
      ),
    },
  },
});
