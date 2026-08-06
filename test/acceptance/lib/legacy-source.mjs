import { createHash } from 'node:crypto';
import { lstat, opendir, readFile } from 'node:fs/promises';
import path from 'node:path';

const SOURCE_EXTENSIONS = new Set(['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx']);
const EXCLUDED_DIRECTORIES = new Set([
  '.git',
  '.tools',
  '.vite',
  'artifacts',
  'coverage',
  'dist',
  'node_modules',
  'screenshots',
]);
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;

export const LEGACY_SOURCE_SCHEMA = 'subagent-v2-legacy-source-baseline/v1';
export const DEFAULT_SCAN_ROOTS = Object.freeze(['packages', 'demo']);
export const LEGACY_RULES = Object.freeze([
  Object.freeze({ id: 'v1-sub-agents-option', token: 'subAgents' }),
  Object.freeze({ id: 'v1-agent-constructor', token: 'AgentConstructor' }),
  Object.freeze({ id: 'v1-agent-instance', token: 'AgentInstance' }),
  Object.freeze({ id: 'v1-runtime-sub-agent', token: 'RuntimeSubAgent' }),
  Object.freeze({ id: 'v1-wire-agent-name', token: 'agentName' }),
  Object.freeze({ id: 'v1-wire-output-description', token: 'outputDescription' }),
  Object.freeze({
    id: 'v1-agent-static-description',
    pattern: /\bstatic\s+(?:readonly\s+)?description\b/gu,
  }),
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function toPortablePath(value) {
  return value.split(path.sep).join('/');
}

function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isSourceFile(filePath) {
  if (filePath.endsWith('.d.ts') || filePath.endsWith('.d.mts') || filePath.endsWith('.d.cts')) {
    return false;
  }
  return SOURCE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

async function collectSourceFiles(rootDirectory, relativeRoots) {
  const files = [];

  async function visit(directory) {
    const entries = [];
    const handle = await opendir(directory);
    for await (const entry of handle) entries.push(entry);
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));

    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name)) await visit(entryPath);
        continue;
      }
      if (entry.isFile() && isSourceFile(entryPath)) files.push(entryPath);
    }
  }

  for (const relativeRoot of relativeRoots) {
    assert(
      typeof relativeRoot === 'string' &&
        relativeRoot.length > 0 &&
        !path.isAbsolute(relativeRoot) &&
        !relativeRoot.split(/[\\/]/u).includes('..'),
      `unsafe legacy scan root: ${String(relativeRoot)}`,
    );
    const scanRoot = path.resolve(rootDirectory, relativeRoot);
    assert(
      isPathInside(rootDirectory, scanRoot),
      `legacy scan root escapes repository: ${relativeRoot}`,
    );
    const metadata = await lstat(scanRoot).catch(() => null);
    assert(
      metadata?.isDirectory() === true,
      `legacy scan root is not a directory: ${relativeRoot}`,
    );
    assert(!metadata.isSymbolicLink(), `legacy scan root must not be a symlink: ${relativeRoot}`);
    await visit(scanRoot);
  }

  return files;
}

function normalizeLine(line) {
  return line.trim().replace(/\s+/gu, ' ');
}

function lineDigest(line) {
  return createHash('sha256').update(normalizeLine(line), 'utf8').digest('hex');
}

function countToken(line, token) {
  const matcher = new RegExp(`\\b${token}\\b`, 'gu');
  let count = 0;
  while (matcher.exec(line) !== null) count += 1;
  return count;
}

function countRule(line, rule) {
  if (rule.token !== undefined) return countToken(line, rule.token);
  rule.pattern.lastIndex = 0;
  let count = 0;
  while (rule.pattern.exec(line) !== null) count += 1;
  return count;
}

export async function scanLegacySource({ rootDirectory, scanRoots = DEFAULT_SCAN_ROOTS } = {}) {
  assert(
    typeof rootDirectory === 'string' && rootDirectory.length > 0,
    'rootDirectory is required',
  );
  const resolvedRoot = path.resolve(rootDirectory);
  const rootMetadata = await lstat(resolvedRoot).catch(() => null);
  assert(
    rootMetadata?.isDirectory() === true,
    `repository root is not a directory: ${resolvedRoot}`,
  );
  assert(!rootMetadata.isSymbolicLink(), `repository root must not be a symlink: ${resolvedRoot}`);

  const files = await collectSourceFiles(resolvedRoot, scanRoots);
  const hits = [];

  for (const filePath of files) {
    const metadata = await lstat(filePath);
    assert(metadata.size <= MAX_SOURCE_BYTES, `source file exceeds 4 MiB: ${filePath}`);
    const source = await readFile(filePath, 'utf8');
    const lines = source.replace(/^\uFEFF/u, '').split(/\r?\n/u);
    const relativePath = toPortablePath(path.relative(resolvedRoot, filePath));

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      for (const rule of LEGACY_RULES) {
        const count = countRule(line, rule);
        if (count === 0) continue;
        hits.push({
          rule: rule.id,
          path: relativePath,
          line: index + 1,
          lineDigest: lineDigest(line),
          count,
        });
      }
    }
  }

  return hits.sort(
    (left, right) =>
      left.path.localeCompare(right.path, 'en') ||
      left.line - right.line ||
      left.rule.localeCompare(right.rule, 'en'),
  );
}

function aggregateHits(hits) {
  const entries = new Map();
  for (const hit of hits) {
    const key = `${hit.rule}\0${hit.path}\0${hit.lineDigest}`;
    const current = entries.get(key);
    if (current) {
      current.count += hit.count;
      current.lines.push(hit.line);
    } else {
      entries.set(key, {
        rule: hit.rule,
        path: hit.path,
        lineDigest: hit.lineDigest,
        count: hit.count,
        lines: [hit.line],
      });
    }
  }
  return entries;
}

export function createLegacyBaseline(hits, scanRoots = DEFAULT_SCAN_ROOTS) {
  const entries = [...aggregateHits(hits).values()]
    .map((entry) => ({
      rule: entry.rule,
      path: entry.path,
      lineDigest: entry.lineDigest,
      count: entry.count,
    }))
    .sort(
      (left, right) =>
        left.path.localeCompare(right.path, 'en') ||
        left.rule.localeCompare(right.rule, 'en') ||
        left.lineDigest.localeCompare(right.lineDigest, 'en'),
    );
  return {
    schema: LEGACY_SOURCE_SCHEMA,
    scanRoots: [...scanRoots],
    rules: LEGACY_RULES.map(({ id }) => id),
    entries,
  };
}

export function validateLegacyBaseline(baseline, scanRoots = DEFAULT_SCAN_ROOTS) {
  assert(
    baseline !== null && typeof baseline === 'object' && !Array.isArray(baseline),
    'baseline must be an object',
  );
  assert(
    baseline.schema === LEGACY_SOURCE_SCHEMA,
    `unsupported legacy baseline schema: ${String(baseline.schema)}`,
  );
  assert(
    JSON.stringify(baseline.scanRoots) === JSON.stringify([...scanRoots]),
    'legacy baseline scanRoots do not match the active scanner',
  );
  assert(
    JSON.stringify(baseline.rules) === JSON.stringify(LEGACY_RULES.map(({ id }) => id)),
    'legacy baseline rules do not match the active scanner',
  );
  assert(Array.isArray(baseline.entries), 'legacy baseline entries must be an array');

  const seen = new Set();
  for (const [index, entry] of baseline.entries.entries()) {
    assert(
      entry !== null && typeof entry === 'object' && !Array.isArray(entry),
      `baseline entry ${index} must be an object`,
    );
    assert(
      LEGACY_RULES.some(({ id }) => id === entry.rule),
      `baseline entry ${index} has an unknown rule`,
    );
    assert(
      typeof entry.path === 'string' && entry.path.length > 0,
      `baseline entry ${index} has an invalid path`,
    );
    assert(
      !entry.path.includes('\\') && !entry.path.split('/').includes('..'),
      `baseline entry ${index} has an unsafe path`,
    );
    assert(
      /^[a-f0-9]{64}$/u.test(entry.lineDigest),
      `baseline entry ${index} has an invalid lineDigest`,
    );
    assert(
      Number.isSafeInteger(entry.count) && entry.count > 0,
      `baseline entry ${index} has an invalid count`,
    );
    const key = `${entry.rule}\0${entry.path}\0${entry.lineDigest}`;
    assert(!seen.has(key), `legacy baseline contains duplicate entry ${index}`);
    seen.add(key);
  }
  return baseline;
}

export function findNewLegacyHits(hits, baseline) {
  const current = aggregateHits(hits);
  const allowed = new Map(
    (baseline?.entries ?? []).map((entry) => [
      `${entry.rule}\0${entry.path}\0${entry.lineDigest}`,
      entry.count,
    ]),
  );
  const additions = [];

  for (const [key, entry] of current) {
    const excess = entry.count - (allowed.get(key) ?? 0);
    if (excess <= 0) continue;
    additions.push({
      rule: entry.rule,
      path: entry.path,
      line: Math.min(...entry.lines),
      count: excess,
    });
  }

  return additions.sort(
    (left, right) =>
      left.path.localeCompare(right.path, 'en') ||
      left.line - right.line ||
      left.rule.localeCompare(right.rule, 'en'),
  );
}
