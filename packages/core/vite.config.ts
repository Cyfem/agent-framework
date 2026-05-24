import { transformAsync } from '@babel/core';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const entry = fileURLToPath(new URL('./src/index.ts', import.meta.url));

/**
 * 使用 Babel 在库构建前转换 TypeScript 源码中的 2023-11 decorators。
 *
 * Vite/rolldown 本身不会替我们处理当前装饰器提案语义，因此库包和 demo 都复用
 * 这段插件，确保 `@Tool` initializer 行为与 TypeScript 类型检查保持一致。
 */
function decoratorsBabelPlugin(): Plugin {
  return {
    name: 'babel-2023-11-decorators',
    enforce: 'pre',
    async transform(code, id) {
      if (id.includes('\0') || id.endsWith('.d.ts') || !/\.[cm]?tsx?$/.test(id)) {
        return null;
      }

      const result = await transformAsync(code, {
        filename: id,
        babelrc: false,
        configFile: false,
        sourceMaps: false,
        plugins: [['@babel/plugin-proposal-decorators', { version: '2023-11' }]],
        presets: [['@babel/preset-typescript', { allowDeclareFields: true }]],
      });

      if (!result?.code) {
        return null;
      }

      return {
        code: result.code,
      };
    },
  };
}

export default defineConfig({
  plugins: [decoratorsBabelPlugin()],
  build: {
    target: 'node22',
    sourcemap: true,
    rollupOptions: {
      // 核心包面向 Node.js 运行时，保留依赖和 Node 内置模块为外部引用。
      // 发布产物只打包框架源码，避免把 openai/zod 等依赖复制进库文件。
      external: ['openai', 'zod', 'zod-to-json-schema', /^node:/],
    },
    lib: {
      entry,
      formats: ['es', 'cjs'],
      fileName: (format) => (format === 'es' ? 'index.js' : 'index.cjs'),
    },
  },
});
