import { transformAsync } from '@babel/core';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));

function decoratorsBabelPlugin(): Plugin {
  return {
    name: 'electron-weixin-babel-2023-11-decorators',
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

      return result?.code ? { code: result.code } : null;
    },
  };
}

export default defineConfig({
  root,
  plugins: [decoratorsBabelPlugin()],
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
