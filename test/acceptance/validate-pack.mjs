#!/usr/bin/env node
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { validatePackageArtifact, validatePackChildTerminationSelfTest } from './lib/pack.mjs';

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
      [
        'expected-name',
        'expected-version',
        'package-dir',
        'peer-package-dir',
        'self-test',
      ].includes(key),
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

async function expectFailure(action, pattern, label) {
  try {
    await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert(pattern.test(message), `${label} failed with the wrong diagnostic: ${message}`);
    return;
  }
  throw new Error(`${label} unexpectedly passed`);
}

async function selfTest() {
  const directory = await mkdtemp(path.join(tmpdir(), 'manee-pack-validator-'));
  try {
    const safeEnvironmentNameSource =
      "export const documentedEnvironmentNames = ['ARK_API_KEY', 'OPENAI_API_KEY', 'AWS_ACCESS_KEY_ID'];\n";
    await mkdir(path.join(directory, 'dist'), { recursive: true });
    await writeFile(
      path.join(directory, 'package.json'),
      `${JSON.stringify(
        {
          name: '@fixture/subagent-v2-pack',
          version: '2.0.0',
          type: 'module',
          engines: { node: '>=22' },
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
    await writeFile(path.join(directory, 'dist', 'index.js'), safeEnvironmentNameSource, 'utf8');
    await writeFile(path.join(directory, 'dist', 'index.cjs'), 'module.exports = {};\n', 'utf8');
    await mkdir(path.join(directory, 'dist', 'internal'), { recursive: true });
    await writeFile(
      path.join(directory, 'dist', 'index.d.ts'),
      'export type * from "./internal/index.js";\n',
      'utf8',
    );
    await writeFile(
      path.join(directory, 'dist', 'internal', 'index.d.ts'),
      'export interface FixtureContract { readonly status: "passed"; }\n',
      'utf8',
    );
    await writeFile(path.join(directory, 'dist', 'index.js.map'), '{}\n', 'utf8');
    await writeFile(path.join(directory, 'dist', 'index.cjs.map'), '{}\n', 'utf8');
    const happyPath = await validatePackageArtifact({
      packageDirectory: directory,
      expectedPackageName: '@fixture/subagent-v2-pack',
      expectedVersion: '2.0.0',
    });
    const validateFixture = () =>
      validatePackageArtifact({
        packageDirectory: directory,
        expectedPackageName: '@fixture/subagent-v2-pack',
        expectedVersion: '2.0.0',
      });

    const tokenPath = path.join(directory, 'dist', 'token.json');
    await writeFile(tokenPath, '{"token":"must-not-pack"}\n', 'utf8');
    await expectFailure(
      validateFixture,
      /unsupported dist artifact|secret-sensitive path/iu,
      'sensitive dist artifact rejection',
    );
    await rm(tokenPath, { force: true });

    const privateKeyPath = path.join(directory, 'dist', 'private-key.js');
    await writeFile(privateKeyPath, 'export const leaked = true;\n', 'utf8');
    await expectFailure(
      validateFixture,
      /secret-sensitive path/iu,
      'sensitive path pattern rejection',
    );
    await rm(privateKeyPath, { force: true });

    const sourcePath = path.join(directory, 'dist', 'source.ts');
    await writeFile(sourcePath, 'export {};\n', 'utf8');
    await expectFailure(
      validateFixture,
      /unsupported dist artifact|TypeScript source/iu,
      'TypeScript source rejection',
    );
    await rm(sourcePath, { force: true });

    const esmPath = path.join(directory, 'dist', 'index.js');
    await writeFile(
      esmPath,
      'export const fixtureSecret = "MANEE_PACK_CONTENT_SECRET_0123456789ABCDEF";\n',
      'utf8',
    );
    await expectFailure(
      validateFixture,
      /secret-like content \(pack-validator secret marker\) in dist\/index\.js/iu,
      'secret content rejection',
    );
    await writeFile(esmPath, safeEnvironmentNameSource, 'utf8');

    const esmMapPath = path.join(directory, 'dist', 'index.js.map');
    await writeFile(
      esmMapPath,
      `${JSON.stringify({
        version: 3,
        sources: ['fixture.ts'],
        names: [],
        mappings: '',
        sourcesContent: [
          'export const fixtureSecret = "MANEE_PACK_CONTENT_SECRET_ABCDEF0123456789";',
        ],
      })}\n`,
      'utf8',
    );
    await expectFailure(
      validateFixture,
      /secret-like content \(pack-validator secret marker\) in dist\/index\.js\.map/iu,
      'source map sourcesContent secret rejection',
    );
    await writeFile(esmMapPath, '{}\n', 'utf8');

    const cjsMapPath = path.join(directory, 'dist', 'index.cjs.map');
    await rm(cjsMapPath, { force: true });
    await expectFailure(validateFixture, /CJS source map is missing/iu, 'missing map rejection');
    await writeFile(cjsMapPath, '{}\n', 'utf8');

    return {
      ...happyPath,
      negativeCases: [
        'sensitive-dist-artifact',
        'sensitive-path-pattern',
        'typescript-source',
        'secret-content',
        'source-map-secret-content',
        'missing-source-map',
      ],
      childTermination: await validatePackChildTerminationSelfTest(),
    };
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
  const expectedPackageName = optionString(options, 'expected-name', undefined);
  assert(expectedPackageName !== undefined, '--expected-name is required');
  const expectedVersion = optionString(options, 'expected-version', '2.0.0');
  const packageDirectory = path.resolve(repoRoot, packageArgument);
  const peerPackageArgument = optionString(options, 'peer-package-dir', undefined);
  const peerPackageDirectories = peerPackageArgument
    ? [path.resolve(repoRoot, peerPackageArgument)]
    : [];
  return {
    status: 'passed',
    mode: 'npm-pack-runtime-and-node-next-consumers',
    package: await validatePackageArtifact({
      packageDirectory,
      expectedPackageName,
      peerPackageDirectories,
      expectedVersion,
    }),
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
