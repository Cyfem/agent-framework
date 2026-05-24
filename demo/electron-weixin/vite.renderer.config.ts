import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('./renderer', import.meta.url)),
  base: './',
  build: {
    target: 'es2023',
    outDir: '../.electron/renderer',
    emptyOutDir: true,
    sourcemap: true,
  },
});
