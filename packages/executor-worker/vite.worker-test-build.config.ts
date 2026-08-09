import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

import { createDecoratorsPlugin } from '../../tooling/vite/decorators';

export default defineConfig({
  plugins: [createDecoratorsPlugin()],
  build: {
    target: 'node22',
    sourcemap: true,
    outDir: '.artifacts/worker-test',
    emptyOutDir: true,
    rollupOptions: {
      external: ['@ruixutong.manee/maneeagent-framework', /^node:/],
    },
    lib: {
      entry: fileURLToPath(new URL('./src/worker-protocol.ts', import.meta.url)),
      formats: ['es'],
      fileName: () => 'worker-protocol.js',
    },
  },
});
