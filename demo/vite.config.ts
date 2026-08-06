import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { createDecoratorsPlugin } from '../tooling/vite/decorators';

const entry = fileURLToPath(new URL('./src/main.ts', import.meta.url));
const coreEntry = fileURLToPath(new URL('../packages/core/src/index.ts', import.meta.url));
const localExecutorEntry = fileURLToPath(
  new URL('../packages/executor-local/src/index.ts', import.meta.url),
);

export default defineConfig({
  plugins: [createDecoratorsPlugin()],
  resolve: {
    alias: {
      // 在工作区内直接验证 Core 与 Local Executor 源码，不要求先发布到 npm。
      '@manee/agent-framework': coreEntry,
      '@manee/agent-executor-local': localExecutorEntry,
      '@ruixutong.manee/maneeagent-framework': coreEntry,
    },
  },
  build: {
    target: 'node22',
    ssr: entry,
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
});
