import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { createDecoratorsPlugin } from '../../tooling/vite/decorators';

const entry = fileURLToPath(new URL('./src/index.ts', import.meta.url));

export default defineConfig({
  plugins: [createDecoratorsPlugin()],
  test: {
    environment: 'node',
    globals: false,
    clearMocks: true,
    setupFiles: ['test/network-deny.setup.ts'],
    include: ['test/**/*.test.ts'],
  },
  build: {
    target: 'node22',
    sourcemap: true,
    rollupOptions: {
      // 核心包面向 Node.js 运行时，保留依赖和 Node 内置模块为外部引用。
      // 发布产物只打包框架源码，避免把 openai/zod 等依赖复制进库文件。
      external: ['openai', 'yaml', 'zod', 'zod-to-json-schema', /^node:/],
    },
    lib: {
      entry,
      formats: ['es', 'cjs'],
      fileName: (format) => (format === 'es' ? 'index.js' : 'index.cjs'),
    },
  },
});
