#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  createLegacyBaseline,
  DEFAULT_SCAN_ROOTS,
  findNewLegacyHits,
  scanLegacySource,
  validateLegacyBaseline,
} from './lib/legacy-source.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, '..', '..');
const defaultBaselinePath = path.join(scriptDirectory, 'fixtures', 'legacy-source-baseline.json');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseArgs(argv) {
  const options = new Map();
  for (const arg of argv) {
    assert(arg.startsWith('--'), `unexpected positional argument: ${arg}`);
    const separator = arg.indexOf('=');
    const key = separator === -1 ? arg.slice(2) : arg.slice(2, separator);
    const value = separator === -1 ? true : arg.slice(separator + 1);
    assert(key.length > 0 && !options.has(key), `duplicate or empty option: ${arg}`);
    assert(
      ['baseline', 'forbid-all', 'root', 'self-test', 'snapshot'].includes(key),
      `unsupported option: --${key}`,
    );
    options.set(key, value);
  }
  return options;
}

function optionPath(options, key, fallback, baseDirectory) {
  const value = options.get(key);
  if (value === undefined || value === true) return fallback;
  assert(typeof value === 'string' && value.length > 0, `--${key} requires a path`);
  return path.resolve(baseDirectory, value);
}

async function writeJsonAtomic(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function loadBaseline(target) {
  const source = await readFile(target, 'utf8').catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (source === null) return null;
  try {
    return JSON.parse(source.replace(/^\uFEFF/u, ''));
  } catch (error) {
    throw new Error(
      `legacy baseline is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

async function selfTest() {
  const root = await mkdtemp(path.join(tmpdir(), 'manee-legacy-source-'));
  try {
    await mkdir(path.join(root, 'packages', 'core', 'src'), { recursive: true });
    await mkdir(path.join(root, 'demo', 'src'), { recursive: true });
    await writeFile(
      path.join(root, 'packages', 'core', 'src', 'legacy.ts'),
      'type Old = AgentConstructor<unknown>;\nconst options = { subAgents: [] };\n',
      'utf8',
    );
    await writeFile(
      path.join(root, 'demo', 'src', 'clean.ts'),
      'const input = { subAgent: "worker" };\n',
      'utf8',
    );
    const initial = await scanLegacySource({ rootDirectory: root });
    assert(
      initial.length === 2,
      `self-test expected two initial legacy hits, got ${initial.length}`,
    );
    const baseline = createLegacyBaseline(initial);
    assert(
      findNewLegacyHits(initial, baseline).length === 0,
      'self-test baseline rejected its own hits',
    );
    await writeFile(
      path.join(root, 'demo', 'src', 'new.ts'),
      'const oldWire = { agentName: "worker", outputDescription: "proof" };\n',
      'utf8',
    );
    const additions = findNewLegacyHits(await scanLegacySource({ rootDirectory: root }), baseline);
    assert(
      additions.length === 2,
      `self-test expected two new legacy hits, got ${additions.length}`,
    );
    return { initialHits: initial.length, detectedAdditions: additions.length };
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.has('self-test')) {
    assert(options.size === 1, '--self-test cannot be combined with other options');
    return { status: 'passed', mode: 'self-test', ...(await selfTest()) };
  }

  assert(
    !(options.has('baseline') && options.has('snapshot')),
    '--baseline and --snapshot are mutually exclusive',
  );
  assert(
    !(options.has('baseline') && options.has('forbid-all')),
    '--baseline and --forbid-all are mutually exclusive',
  );
  const rootDirectory = optionPath(options, 'root', repoRoot, process.cwd());
  const hits = await scanLegacySource({ rootDirectory, scanRoots: DEFAULT_SCAN_ROOTS });

  if (options.has('baseline')) {
    const baselinePath = optionPath(options, 'baseline', defaultBaselinePath, rootDirectory);
    const baseline = createLegacyBaseline(hits, DEFAULT_SCAN_ROOTS);
    await writeJsonAtomic(baselinePath, baseline);
    return {
      status: 'passed',
      mode: 'baseline-written',
      baseline: path.relative(rootDirectory, baselinePath).split(path.sep).join('/'),
      legacyHits: hits.reduce((total, hit) => total + hit.count, 0),
      entries: baseline.entries.length,
    };
  }

  const baselinePath = optionPath(options, 'snapshot', defaultBaselinePath, rootDirectory);
  const loaded = options.has('forbid-all') ? null : await loadBaseline(baselinePath);
  const baseline =
    loaded === null ? { entries: [] } : validateLegacyBaseline(loaded, DEFAULT_SCAN_ROOTS);
  const additions = findNewLegacyHits(hits, baseline);
  if (additions.length > 0) {
    const diagnostic = additions
      .slice(0, 20)
      .map((hit) => `${hit.path}:${hit.line} ${hit.rule} (+${hit.count})`)
      .join('\n');
    throw new Error(
      `legacy Subagent v1 source was added${loaded === null ? ' (no baseline is active)' : ' beyond the frozen baseline'}:\n${diagnostic}`,
    );
  }

  return {
    status: 'passed',
    mode: loaded === null ? 'forbid-all' : 'no-new-hits',
    baselineEntries: loaded?.entries.length ?? 0,
    currentLegacyHits: hits.reduce((total, hit) => total + hit.count, 0),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(await main())}\n`);
  } catch (error) {
    process.stderr.write(
      `[subagent-v2 legacy validation] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
