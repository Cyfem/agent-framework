import { transformAsync } from '@babel/core';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const entry = fileURLToPath(new URL('./src/main.ts', import.meta.url));
const coreEntry = fileURLToPath(new URL('../packages/core/src/index.ts', import.meta.url));

/** 使用与发布包一致的 Babel 转换链处理 demo 中的 2023-11 decorators。 */
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
  resolve: {
    alias: {
      // 在工作区内直接验证 core 源码，不要求先将本地包发布到 npm。
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
