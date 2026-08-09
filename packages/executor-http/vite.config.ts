import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

import { createDecoratorsPlugin } from '../../tooling/vite/decorators';

const entry = fileURLToPath(new URL('./src/index.ts', import.meta.url));

export default defineConfig({
  plugins: [createDecoratorsPlugin()],
  resolve: {
    alias: {
      '@ruixutong.manee/maneeagent-framework': fileURLToPath(
        new URL('../core/src/index.ts', import.meta.url),
      ),
    },
  },
  build: {
    target: 'node22',
    sourcemap: true,
    rollupOptions: {
      external: ['@ruixutong.manee/maneeagent-framework', /^node:/],
    },
    lib: {
      entry,
      formats: ['es', 'cjs'],
      fileName: (format) => (format === 'es' ? 'index.js' : 'index.cjs'),
    },
  },
});
