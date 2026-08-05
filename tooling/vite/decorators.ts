import { transformAsync } from '@babel/core';
import type { Plugin } from 'vite';

/**
 * Create the single repository-wide Vite transform for 2023-11 decorators.
 *
 * Keeping the transform in one place ensures library, demo, Electron, test and
 * future executor builds all use the same decorator proposal semantics.
 */
export function createDecoratorsPlugin(): Plugin {
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

      return result?.code ? { code: result.code } : null;
    },
  };
}
