import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root,
  build: {
    target: 'node22',
    outDir: '.electron/main',
    emptyOutDir: false,
    sourcemap: true,
    ssr: true,
    rollupOptions: {
      input: {
        preload: fileURLToPath(new URL('./preload.ts', import.meta.url)),
      },
      external: ['electron'],
      output: {
        format: 'cjs',
        entryFileNames: '[name].cjs',
      },
    },
  },
});
