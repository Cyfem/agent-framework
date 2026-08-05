#!/usr/bin/env node
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { validatePackageDryRun } from './lib/pack.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, '..', '..');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseArgs(argv) {
  const options = new Map();
  let positionalPackage;
  for (const arg of argv) {
    if (!arg.startsWith('--')) {
      assert(positionalPackage === undefined, `unexpected positional argument: ${arg}`);
      positionalPackage = arg;
      continue;
    }
    const separator = arg.indexOf('=');
    const key = separator === -1 ? arg.slice(2) : arg.slice(2, separator);
    const value = separator === -1 ? true : arg.slice(separator + 1);
    assert(key.length > 0 && !options.has(key), `duplicate or empty option: ${arg}`);
    assert(
      ['expected-version', 'package-dir', 'self-test'].includes(key),
      `unsupported option: --${key}`,
    );
    options.set(key, value);
  }
  assert(
    !(positionalPackage && options.has('package-dir')),
    'use either a positional package directory or --package-dir, not both',
  );
  return { options, positionalPackage };
}

function optionString(options, key, fallback) {
  const value = options.get(key);
  if (value === undefined) return fallback;
  assert(
    typeof value === 'string' && value.length > 0,
    `--${key} requires a value using --${key}=...`,
  );
  return value;
}

async function selfTest() {
  const directory = await mkdtemp(path.join(tmpdir(), 'manee-pack-validator-'));
  try {
    await mkdir(path.join(directory, 'dist'), { recursive: true });
    await writeFile(
      path.join(directory, 'package.json'),
      `${JSON.stringify(
        {
          name: '@fixture/subagent-v2-pack',
          version: '2.0.0',
          type: 'module',
          files: ['dist', 'README.md'],
          main: './dist/index.cjs',
          module: './dist/index.js',
          types: './dist/index.d.ts',
          exports: {
            '.': {
              types: './dist/index.d.ts',
              import: './dist/index.js',
              require: './dist/index.cjs',
            },
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    await writeFile(path.join(directory, 'README.md'), '# pack validator fixture\n', 'utf8');
    await writeFile(path.join(directory, 'dist', 'index.js'), 'export {};\n', 'utf8');
    await writeFile(path.join(directory, 'dist', 'index.cjs'), 'module.exports = {};\n', 'utf8');
    await writeFile(path.join(directory, 'dist', 'index.d.ts'), 'export {};\n', 'utf8');
    await writeFile(path.join(directory, 'dist', 'index.js.map'), '{}\n', 'utf8');
    await writeFile(path.join(directory, 'dist', 'index.cjs.map'), '{}\n', 'utf8');
    return await validatePackageDryRun({ packageDirectory: directory, expectedVersion: '2.0.0' });
  } finally {
    await rm(directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
  }
}

export async function main(argv = process.argv.slice(2)) {
  const { options, positionalPackage } = parseArgs(argv);
  if (options.has('self-test')) {
    assert(
      options.size === 1 && positionalPackage === undefined,
      '--self-test cannot be combined with other options',
    );
    return { status: 'passed', mode: 'self-test', package: await selfTest() };
  }

  const packageArgument =
    positionalPackage ?? optionString(options, 'package-dir', 'packages/core');
  const expectedVersion = optionString(options, 'expected-version', '2.0.0');
  const packageDirectory = path.resolve(repoRoot, packageArgument);
  return {
    status: 'passed',
    mode: 'npm-pack-dry-run',
    package: await validatePackageDryRun({ packageDirectory, expectedVersion }),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(await main())}\n`);
  } catch (error) {
    process.stderr.write(
      `[subagent-v2 pack validation] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
