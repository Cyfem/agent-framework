import { spawn } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const FORBIDDEN_PATH_SEGMENTS = new Set(['plans', 'source', 'src', 'test', 'testkit', 'tests']);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function normalizePackagePath(value, field) {
  assert(typeof value === 'string' && value.length > 0, `${field} must be a non-empty string`);
  const normalized = value.replace(/^\.\//u, '').replace(/\\/gu, '/');
  assert(!path.posix.isAbsolute(normalized), `${field} must be package-relative`);
  assert(!/^[a-zA-Z]:/u.test(normalized), `${field} must not have a drive prefix`);
  assert(
    normalized.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
    `${field} contains an unsafe path segment`,
  );
  return normalized;
}

function readConditionalExport(packageJson, condition) {
  const rootExport = packageJson.exports?.['.'] ?? packageJson.exports;
  if (rootExport === null || typeof rootExport !== 'object' || Array.isArray(rootExport))
    return undefined;
  const value = rootExport[condition];
  return typeof value === 'string' ? value : undefined;
}

function collectChild(child, maxBytes) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let bytes = 0;

    const append = (stream, chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        child.kill();
        reject(new Error(`npm pack output exceeded ${maxBytes} bytes`));
        return stream;
      }
      return stream + chunk.toString('utf8');
    };

    child.stdout.on('data', (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = append(stderr, chunk);
    });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function runNpmPack(packageDirectory) {
  const destination = await mkdtemp(path.join(tmpdir(), 'manee-pack-dry-run-'));
  try {
    const bundledNpmCli = path.join(
      path.dirname(process.execPath),
      'node_modules',
      'npm',
      'bin',
      'npm-cli.js',
    );
    const hasBundledNpm = (await stat(bundledNpmCli).catch(() => null))?.isFile() === true;
    const npmCommand = hasBundledNpm ? process.execPath : 'npm';
    const npmPrefix = hasBundledNpm ? [bundledNpmCli] : [];
    const child = spawn(
      npmCommand,
      [
        ...npmPrefix,
        'pack',
        '--dry-run',
        '--json',
        '--ignore-scripts',
        `--pack-destination=${destination}`,
        '--loglevel=error',
      ],
      {
        cwd: packageDirectory,
        env: process.env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    const result = await collectChild(child, MAX_OUTPUT_BYTES);
    assert(
      result.code === 0,
      `npm pack --dry-run failed (${result.signal ?? result.code}): ${result.stderr.trim() || 'no diagnostic output'}`,
    );
    let parsed;
    try {
      parsed = JSON.parse(result.stdout.replace(/^\uFEFF/u, ''));
    } catch (error) {
      throw new Error(
        `npm pack did not return valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    assert(
      Array.isArray(parsed) && parsed.length === 1,
      'npm pack must describe exactly one package',
    );
    return parsed[0];
  } finally {
    await rm(destination, { force: true, recursive: true });
  }
}

function assertPublishedFile(files, target, field) {
  const normalized = normalizePackagePath(target, field);
  assert(files.has(normalized), `${field} is missing from npm pack output: ${normalized}`);
  return normalized;
}

export async function validatePackageDryRun({ packageDirectory, expectedVersion = '2.0.0' }) {
  assert(
    typeof packageDirectory === 'string' && packageDirectory.length > 0,
    'packageDirectory is required',
  );
  assert(
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(expectedVersion),
    `invalid expected version: ${String(expectedVersion)}`,
  );
  const resolvedDirectory = await realpath(path.resolve(packageDirectory)).catch(() => null);
  assert(resolvedDirectory !== null, `package directory does not exist: ${packageDirectory}`);
  const directoryMetadata = await stat(resolvedDirectory);
  assert(directoryMetadata.isDirectory(), `package path is not a directory: ${packageDirectory}`);

  const manifestPath = path.join(resolvedDirectory, 'package.json');
  const manifestSource = await readFile(manifestPath, 'utf8').catch(() => null);
  assert(manifestSource !== null, `package.json is missing from ${resolvedDirectory}`);
  let packageJson;
  try {
    packageJson = JSON.parse(manifestSource.replace(/^\uFEFF/u, ''));
  } catch (error) {
    throw new Error(
      `package.json is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  assert(
    packageJson.version === expectedVersion,
    `package.json version ${String(packageJson.version)} does not match ${expectedVersion}`,
  );

  const pack = await runNpmPack(resolvedDirectory);
  assert(
    pack !== null && typeof pack === 'object' && !Array.isArray(pack),
    'npm pack result must be an object',
  );
  assert(
    pack.version === expectedVersion,
    `packed version ${String(pack.version)} does not match ${expectedVersion}`,
  );
  assert(Array.isArray(pack.files), 'npm pack result.files must be an array');

  const fileList = pack.files.map((entry, index) =>
    normalizePackagePath(entry?.path, `npm pack files[${index}].path`),
  );
  const files = new Set(fileList);
  assert(files.size === fileList.length, 'npm pack output contains duplicate file paths');
  assert(
    fileList.some((file) => file.toLowerCase() === 'readme.md'),
    'npm pack output must include a root README.md',
  );

  for (const file of fileList) {
    const segments = file.toLowerCase().split('/');
    assert(
      !segments.some((segment) => FORBIDDEN_PATH_SEGMENTS.has(segment)),
      `npm pack output leaks a forbidden project path: ${file}`,
    );
    assert(
      !/\.(?:cts|mts|tsx?)$/iu.test(file) || /\.d\.(?:cts|mts|ts)$/iu.test(file),
      `npm pack output leaks TypeScript source: ${file}`,
    );
  }

  const esmEntry = readConditionalExport(packageJson, 'import') ?? packageJson.module;
  const cjsEntry = readConditionalExport(packageJson, 'require') ?? packageJson.main;
  const typesEntry = readConditionalExport(packageJson, 'types') ?? packageJson.types;
  assert(typeof esmEntry === 'string', 'package must declare an ESM import/module entry');
  assert(typeof cjsEntry === 'string', 'package must declare a CJS require/main entry');
  assert(typeof typesEntry === 'string', 'package must declare a declarations entry');

  const esmPath = assertPublishedFile(files, esmEntry, 'ESM entry');
  const cjsPath = assertPublishedFile(files, cjsEntry, 'CJS entry');
  const typesPath = assertPublishedFile(files, typesEntry, 'types entry');
  assert(/\.(?:js|mjs)$/iu.test(esmPath), `ESM entry has an unexpected extension: ${esmPath}`);
  assert(/\.(?:cjs|js)$/iu.test(cjsPath), `CJS entry has an unexpected extension: ${cjsPath}`);
  assert(
    /\.d\.(?:cts|mts|ts)$/iu.test(typesPath),
    `types entry is not a declaration file: ${typesPath}`,
  );
  assertPublishedFile(files, `${esmPath}.map`, 'ESM source map');
  assertPublishedFile(files, `${cjsPath}.map`, 'CJS source map');

  return {
    name: pack.name,
    version: pack.version,
    filename: pack.filename,
    entryCount: fileList.length,
    entries: { esm: esmPath, cjs: cjsPath, types: typesPath },
  };
}
