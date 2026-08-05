import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { createDecoratorsPlugin } from '../../tooling/vite/decorators';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root,
  plugins: [createDecoratorsPlugin()],
  build: {
    target: 'node22',
    outDir: '.electron/main',
    emptyOutDir: true,
    sourcemap: true,
    ssr: true,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./main.ts', import.meta.url)),
      },
      external: ['@manee/agent-framework', 'electron', 'koffi', 'openai', 'pngjs', 'zod'],
      output: {
        format: 'cjs',
        entryFileNames: '[name].cjs',
      },
    },
  },
});
