import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { createDecoratorsPlugin } from '../tooling/vite/decorators';

const entry = fileURLToPath(new URL('./src/main.ts', import.meta.url));
const coreEntry = fileURLToPath(new URL('../packages/core/src/index.ts', import.meta.url));

export default defineConfig({
  plugins: [createDecoratorsPlugin()],
  resolve: {
    alias: {
      // 在工作区内直接验证 core 源码，不要求先将本地包发布到 npm。
      // 这样 demo 可以覆盖最新源码和声明，而不是上一次 build 的包内容。
      '@manee/agent-framework': coreEntry,
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
