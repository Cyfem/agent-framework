import { transformAsync } from '@babel/core';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const entry = fileURLToPath(new URL('./src/index.ts', import.meta.url));

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
      external: ['openai', 'zod', 'zod-to-json-schema'],
    },
    lib: {
      entry,
      formats: ['es', 'cjs'],
      fileName: (format) => (format === 'es' ? 'index.js' : 'index.cjs'),
    },
  },
});
