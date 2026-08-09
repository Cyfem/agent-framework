import { fileURLToPath } from 'node:url';

import { configDefaults, defineConfig } from 'vitest/config';

import { createDecoratorsPlugin } from '../../tooling/vite/decorators';

export default defineConfig({
  plugins: [createDecoratorsPlugin()],
  test: {
    environment: 'node',
    globals: false,
    clearMocks: true,
    include: ['test/**/*.test.ts'],
    exclude: [...configDefaults.exclude, 'test/**/*.process.test.ts'],
    setupFiles: ['test/network-deny.setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      '@ruixutong.manee/maneeagent-framework': fileURLToPath(
        new URL('../core/src/index.ts', import.meta.url),
      ),
    },
  },
});
