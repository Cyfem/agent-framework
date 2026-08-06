import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

import { createDecoratorsPlugin } from '../../tooling/vite/decorators';

const entry = fileURLToPath(
  new URL('./test/process/atomic-file-recovery-worker.ts', import.meta.url),
);

export default defineConfig({
  logLevel: 'silent',
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
    minify: false,
    rollupOptions: {
      external: [/^node:/u],
    },
    lib: {
      entry,
      formats: ['es'],
      fileName: () => 'atomic-file-recovery-worker.mjs',
    },
  },
});
