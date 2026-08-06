import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';

const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const NPM_PACK_TIMEOUT_MS = 120_000;
const PACK_CHILD_TIMEOUT_MS = 60_000;
const FORBIDDEN_PATH_SEGMENTS = new Set(['plans', 'source', 'src', 'test', 'testkit', 'tests']);
const ALLOWED_DIST_FILE_PATTERN = /(?:\.d\.(?:cts|mts|ts)|\.(?:cjs|js|mjs|map))$/iu;
const ALLOWED_ROOT_FILES = new Set([
  'license',
  'license.markdown',
  'license.md',
  'license.txt',
  'licence',
  'licence.markdown',
  'licence.md',
  'licence.txt',
  'package.json',
  'readme',
  'readme.markdown',
  'readme.md',
  'readme.txt',
]);
const SENSITIVE_PACKAGE_PATH_PATTERNS = [
  /(?:^|\/)\.env(?:[./]|$)/iu,
  /(?:^|\/)\.npmrc$/iu,
  /(?:^|\/)(?:credentials?|secrets?)(?:[._-]|$)/iu,
  /(?:^|\/)(?:api|private)[._-]?key(?:[._-]|$)/iu,
  /(?:^|\/)(?:id_(?:dsa|ecdsa|ed25519|rsa)|service[._-]?account)(?:[._-]|$)/iu,
  /(?:^|\/)(?:access[._-]?token|auth|refresh[._-]?token|token)\.(?:ini|json|toml|txt|ya?ml)$/iu,
  /\.(?:cer|cert|crt|jks|key|keystore|log|p12|pem|pfx)$/iu,
];
const RELEASE_PACKAGE_CONTRACTS = Object.freeze({
  '@ruixutong.manee/maneeagent-framework': Object.freeze({
    peerDependencies: Object.freeze({}),
  }),
  '@ruixutong.manee/maneeagent-executor-local': Object.freeze({
    peerDependencies: Object.freeze({
      '@ruixutong.manee/maneeagent-framework': '^2.0.0',
    }),
  }),
});
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, '..', '..', '..');

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

function createChildEnvironment(extra = {}) {
  const allowed = new Set([
    'COMSPEC',
    'LANG',
    'LC_ALL',
    'LOCALAPPDATA',
    'PATH',
    'PATHEXT',
    'SYSTEMROOT',
    'TEMP',
    'TMP',
    'TMPDIR',
  ]);
  const environment = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && allowed.has(key.toUpperCase())) environment[key] = value;
  }
  return { ...environment, ...extra };
}

function collectChild(child, { failureLabel, maxBytes, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let terminationError;
    let spawnError;

    const timeout = setTimeout(() => {
      terminationError ??= new Error(
        `${failureLabel} exceeded the ${timeoutMs}ms wall-clock limit`,
      );
      child.kill('SIGKILL');
    }, timeoutMs);

    const terminate = (error) => {
      if (terminationError !== undefined) return;
      terminationError = error;
      child.kill('SIGKILL');
    };

    const append = (stream, chunk) => {
      if (terminationError !== undefined) return stream;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        terminate(new Error(`${failureLabel} output exceeded ${maxBytes} bytes`));
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
    child.once('error', (error) => {
      spawnError = error;
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      if (terminationError !== undefined) {
        reject(terminationError);
        return;
      }
      if (spawnError !== undefined) {
        reject(spawnError);
        return;
      }
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function runNpmPack(packageDirectory, { dryRun }) {
  const destination = await mkdtemp(path.join(tmpdir(), 'manee-pack-'));
  try {
    const emptyNpmUserConfig = path.join(destination, 'empty.npmrc');
    await writeFile(emptyNpmUserConfig, '', 'utf8');
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
        ...(dryRun ? ['--dry-run'] : []),
        '--json',
        '--ignore-scripts',
        `--pack-destination=${destination}`,
        '--loglevel=error',
      ],
      {
        cwd: packageDirectory,
        env: createChildEnvironment({
          npm_config_audit: 'false',
          npm_config_fund: 'false',
          npm_config_ignore_scripts: 'true',
          npm_config_loglevel: 'error',
          npm_config_update_notifier: 'false',
          npm_config_userconfig: emptyNpmUserConfig,
        }),
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    const result = await collectChild(child, {
      failureLabel: `npm pack${dryRun ? ' --dry-run' : ''}`,
      maxBytes: MAX_OUTPUT_BYTES,
      timeoutMs: NPM_PACK_TIMEOUT_MS,
    });
    assert(
      result.code === 0,
      `npm pack${dryRun ? ' --dry-run' : ''} failed (${result.signal ?? result.code}): ${result.stderr.trim() || 'no diagnostic output'}`,
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
    const pack = parsed[0];
    if (dryRun) return { archive: undefined, pack };
    const filename = normalizePackagePath(pack?.filename, 'npm pack filename');
    assert(path.posix.basename(filename) === filename, 'npm pack filename must not contain a path');
    const archive = await readFile(path.join(destination, filename)).catch(() => null);
    assert(archive !== null, `npm pack did not create its reported archive: ${filename}`);
    return { archive, pack };
  } finally {
    await rm(destination, { force: true, recursive: true });
  }
}

async function runChild(
  command,
  args,
  options,
  failureLabel,
  { maxBytes = MAX_OUTPUT_BYTES, timeoutMs = PACK_CHILD_TIMEOUT_MS } = {},
) {
  const child = spawn(command, args, {
    ...options,
    env: createChildEnvironment(options.env),
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let result;
  try {
    result = await collectChild(child, { failureLabel, maxBytes, timeoutMs });
  } catch (error) {
    throw new Error(
      `${failureLabel}: unable to run ${JSON.stringify(command)}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  assert(
    result.code === 0,
    `${failureLabel} (${result.signal ?? result.code}): ${result.stderr.trim() || result.stdout.trim() || 'no diagnostic output'}`,
  );
  return result;
}

export async function validatePackChildTerminationSelfTest() {
  const outcomes = [];
  for (const scenario of [
    {
      label: 'timeout',
      source: 'setInterval(() => undefined, 1_000);',
      options: { maxBytes: 1_024, timeoutMs: 50 },
      expected: /wall-clock limit/iu,
    },
    {
      label: 'output-limit',
      source: "process.stdout.write('x'.repeat(4_096)); setInterval(() => undefined, 1_000);",
      options: { maxBytes: 1_024, timeoutMs: 5_000 },
      expected: /output exceeded/iu,
    },
  ]) {
    try {
      await runChild(
        process.execPath,
        ['--input-type=module', '--eval', scenario.source],
        { cwd: repoRoot },
        `pack child ${scenario.label} self-test`,
        scenario.options,
      );
      throw new Error(`pack child ${scenario.label} self-test unexpectedly succeeded`);
    } catch (error) {
      assert(
        scenario.expected.test(error instanceof Error ? error.message : String(error)),
        `pack child ${scenario.label} self-test returned the wrong error`,
      );
      outcomes.push(scenario.label);
    }
  }
  return Object.freeze(outcomes);
}

async function linkPackage(targetRoot, dependencyName, sourcePath) {
  const target = path.join(targetRoot, ...dependencyName.split('/'));
  await mkdir(path.dirname(target), { recursive: true });
  const resolvedSource = await realpath(sourcePath).catch(() => null);
  assert(resolvedSource !== null, `installed dependency is missing: ${dependencyName}`);
  const existingTarget = await realpath(target).catch(() => null);
  if (existingTarget !== null) {
    assert(
      existingTarget === resolvedSource,
      `consumer dependency collision for ${dependencyName}: ${existingTarget} !== ${resolvedSource}`,
    );
    return;
  }
  await symlink(resolvedSource, target, process.platform === 'win32' ? 'junction' : 'dir');
}

function createConsumerSource(packageName) {
  if (packageName === '@ruixutong.manee/maneeagent-framework') {
    return `import * as frameworkNamespace from '${packageName}';
import {
  Agent,
  SUBAGENT_TRANSPORT_VERSION,
  SubAgentTransportPeer,
  SubAgentTransportSequenceTracker,
  createSubAgentTransportArtifactSidecar,
  createSubAgentTransportControlDispatcher,
  createSubAgentTransportPeerWriterAdmission,
  createSubAgentTransportRpcEnvelope,
  type AgentRunOutcome,
  type OpenAIChatProtocol,
  type SubAgentExecutionRequestWire,
  type SubAgentExecutorOperationResult,
  type SubAgentTransportControlRequest,
  type SubAgentTransportPeerPacket,
  type SubAgentTransportPeerWriterAdmission,
  type SubAgentTransportRpcEnvelope,
} from '${packageName}';

type IsAny<T> = 0 extends 1 & T ? true : false;
type AssertFalse<T extends false> = T;
type AssertTrue<T extends true> = T;
type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false;
type CoreContractAssertions = [
  AssertFalse<IsAny<typeof Agent>>,
  AssertFalse<IsAny<ConstructorParameters<typeof Agent>>>,
  AssertFalse<IsAny<ConstructorParameters<typeof Agent>[0]>>,
  AssertFalse<IsAny<typeof SubAgentTransportSequenceTracker>>,
  AssertFalse<IsAny<ConstructorParameters<typeof SubAgentTransportSequenceTracker>>>,
  AssertFalse<IsAny<typeof SubAgentTransportPeer>>,
  AssertFalse<IsAny<ConstructorParameters<typeof SubAgentTransportPeer>>>,
  AssertFalse<IsAny<typeof createSubAgentTransportRpcEnvelope>>,
  AssertFalse<IsAny<typeof createSubAgentTransportControlDispatcher>>,
  AssertFalse<IsAny<typeof createSubAgentTransportPeerWriterAdmission>>,
  AssertFalse<IsAny<typeof createSubAgentTransportArtifactSidecar>>,
  AssertFalse<IsAny<AgentRunOutcome<OpenAIChatProtocol>>>,
  AssertFalse<IsAny<SubAgentExecutionRequestWire>>,
  AssertFalse<IsAny<SubAgentExecutionRequestWire['input']>>,
  AssertFalse<IsAny<SubAgentExecutorOperationResult>>,
  AssertFalse<IsAny<SubAgentTransportControlRequest>>,
  AssertFalse<IsAny<SubAgentTransportPeerPacket>>,
  AssertFalse<IsAny<SubAgentTransportPeerWriterAdmission>>,
  AssertFalse<IsAny<SubAgentTransportRpcEnvelope>>,
  AssertTrue<Equal<SubAgentExecutionRequestWire['remainingMs'], number>>,
  AssertTrue<Equal<AgentRunOutcome<OpenAIChatProtocol>['status'], 'succeeded' | 'waiting_approval' | 'cancelled' | 'failed'>>,
  AssertTrue<Equal<SubAgentExecutorOperationResult['type'], 'terminal' | 'paused' | 'recovery_required'>>,
];

const transportVersion: '1' = SUBAGENT_TRANSPORT_VERSION;
const publicValues = [
  Agent,
  SubAgentTransportPeer,
  SubAgentTransportSequenceTracker,
  createSubAgentTransportArtifactSidecar,
  createSubAgentTransportControlDispatcher,
  createSubAgentTransportPeerWriterAdmission,
  createSubAgentTransportRpcEnvelope,
  transportVersion,
] as const;
export type PublicContracts =
  | AgentRunOutcome<OpenAIChatProtocol>
  | SubAgentExecutionRequestWire
  | SubAgentExecutorOperationResult
  | SubAgentTransportControlRequest
  | SubAgentTransportPeerPacket
  | SubAgentTransportPeerWriterAdmission
  | SubAgentTransportRpcEnvelope;
declare const coreContractAssertions: CoreContractAssertions;
void publicValues;
void coreContractAssertions;
// @ts-expect-error The packed declaration surface must not degrade to any.
frameworkNamespace.__maneeMissingExport;
`;
  }
  if (packageName === '@ruixutong.manee/maneeagent-executor-local') {
    return `import * as localExecutorNamespace from '${packageName}';
import {
  AtomicFileAgentRuntimeStateStore,
  LocalSubAgentRunnerRegistry,
  MemoryAgentRuntimeStateStore,
  MemorySubAgentExecutor,
} from '${packageName}';

type IsAny<T> = 0 extends 1 & T ? true : false;
type AssertFalse<T extends false> = T;
type LocalContractAssertions = [
  AssertFalse<IsAny<typeof AtomicFileAgentRuntimeStateStore>>,
  AssertFalse<IsAny<ConstructorParameters<typeof AtomicFileAgentRuntimeStateStore>>>,
  AssertFalse<IsAny<ConstructorParameters<typeof AtomicFileAgentRuntimeStateStore>[0]>>,
  AssertFalse<IsAny<typeof LocalSubAgentRunnerRegistry>>,
  AssertFalse<IsAny<ConstructorParameters<typeof LocalSubAgentRunnerRegistry>>>,
  AssertFalse<IsAny<ConstructorParameters<typeof LocalSubAgentRunnerRegistry>[0]>>,
  AssertFalse<IsAny<NonNullable<ConstructorParameters<typeof LocalSubAgentRunnerRegistry>[0]>[number]>>,
  AssertFalse<IsAny<typeof MemoryAgentRuntimeStateStore>>,
  AssertFalse<IsAny<ConstructorParameters<typeof MemoryAgentRuntimeStateStore>>>,
  AssertFalse<IsAny<ConstructorParameters<typeof MemoryAgentRuntimeStateStore>[0]>>,
  AssertFalse<IsAny<typeof MemorySubAgentExecutor>>,
  AssertFalse<IsAny<ConstructorParameters<typeof MemorySubAgentExecutor>>>,
  AssertFalse<IsAny<ConstructorParameters<typeof MemorySubAgentExecutor>[0]>>,
  AssertFalse<IsAny<ConstructorParameters<typeof MemorySubAgentExecutor>[0]['registry']>>,
];

const publicValues = [
  AtomicFileAgentRuntimeStateStore,
  LocalSubAgentRunnerRegistry,
  MemoryAgentRuntimeStateStore,
  MemorySubAgentExecutor,
] as const;
declare const localContractAssertions: LocalContractAssertions;
void publicValues;
void localContractAssertions;
// @ts-expect-error The packed declaration surface must not degrade to any.
localExecutorNamespace.__maneeMissingExport;
`;
  }
  return `import * as packageApi from '${packageName}';
type IsAny<T> = 0 extends 1 & T ? true : false;
type AssertFalse<T extends false> = T;
type PackageContractAssertions = [AssertFalse<IsAny<typeof packageApi>>];
declare const packageContractAssertions: PackageContractAssertions;
void packageApi;
void packageContractAssertions;
// @ts-expect-error The packed declaration surface must not degrade to any.
packageApi.__maneeMissingExport;
`;
}

function createCommonJsConsumerSource(packageName) {
  if (packageName === '@ruixutong.manee/maneeagent-framework') {
    return `import framework = require('${packageName}');

type IsAny<T> = 0 extends 1 & T ? true : false;
type AssertFalse<T extends false> = T;
type AssertTrue<T extends true> = T;
type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false;
type CoreContractAssertions = [
  AssertFalse<IsAny<typeof framework.Agent>>,
  AssertFalse<IsAny<ConstructorParameters<typeof framework.Agent>>>,
  AssertFalse<IsAny<ConstructorParameters<typeof framework.Agent>[0]>>,
  AssertFalse<IsAny<typeof framework.SubAgentTransportSequenceTracker>>,
  AssertFalse<IsAny<ConstructorParameters<typeof framework.SubAgentTransportSequenceTracker>>>,
  AssertFalse<IsAny<typeof framework.SubAgentTransportPeer>>,
  AssertFalse<IsAny<ConstructorParameters<typeof framework.SubAgentTransportPeer>>>,
  AssertFalse<IsAny<typeof framework.createSubAgentTransportRpcEnvelope>>,
  AssertFalse<IsAny<typeof framework.createSubAgentTransportControlDispatcher>>,
  AssertFalse<IsAny<typeof framework.createSubAgentTransportPeerWriterAdmission>>,
  AssertFalse<IsAny<typeof framework.createSubAgentTransportArtifactSidecar>>,
  AssertFalse<IsAny<framework.AgentRunOutcome<framework.OpenAIChatProtocol>>>,
  AssertFalse<IsAny<framework.SubAgentExecutionRequestWire>>,
  AssertFalse<IsAny<framework.SubAgentExecutionRequestWire['input']>>,
  AssertFalse<IsAny<framework.SubAgentExecutorOperationResult>>,
  AssertFalse<IsAny<framework.SubAgentTransportControlRequest>>,
  AssertFalse<IsAny<framework.SubAgentTransportPeerPacket>>,
  AssertFalse<IsAny<framework.SubAgentTransportPeerWriterAdmission>>,
  AssertFalse<IsAny<framework.SubAgentTransportRpcEnvelope>>,
  AssertTrue<Equal<framework.SubAgentExecutionRequestWire['remainingMs'], number>>,
  AssertTrue<Equal<framework.AgentRunOutcome<framework.OpenAIChatProtocol>['status'], 'succeeded' | 'waiting_approval' | 'cancelled' | 'failed'>>,
  AssertTrue<Equal<framework.SubAgentExecutorOperationResult['type'], 'terminal' | 'paused' | 'recovery_required'>>,
];

const transportVersion: '1' = framework.SUBAGENT_TRANSPORT_VERSION;
const publicValues = [
  framework.Agent,
  framework.SubAgentTransportPeer,
  framework.SubAgentTransportSequenceTracker,
  framework.createSubAgentTransportArtifactSidecar,
  framework.createSubAgentTransportControlDispatcher,
  framework.createSubAgentTransportPeerWriterAdmission,
  framework.createSubAgentTransportRpcEnvelope,
  transportVersion,
] as const;
type PublicContracts =
  | framework.AgentRunOutcome<framework.OpenAIChatProtocol>
  | framework.SubAgentExecutionRequestWire
  | framework.SubAgentExecutorOperationResult
  | framework.SubAgentTransportControlRequest
  | framework.SubAgentTransportPeerPacket
  | framework.SubAgentTransportPeerWriterAdmission
  | framework.SubAgentTransportRpcEnvelope;
declare const coreContractAssertions: CoreContractAssertions;
declare const publicContract: PublicContracts;
void publicValues;
void publicContract;
void coreContractAssertions;
// @ts-expect-error The packed declaration surface must not degrade to any.
framework.__maneeMissingExport;
`;
  }
  if (packageName === '@ruixutong.manee/maneeagent-executor-local') {
    return `import localExecutor = require('${packageName}');

type IsAny<T> = 0 extends 1 & T ? true : false;
type AssertFalse<T extends false> = T;
type LocalContractAssertions = [
  AssertFalse<IsAny<typeof localExecutor.AtomicFileAgentRuntimeStateStore>>,
  AssertFalse<IsAny<ConstructorParameters<typeof localExecutor.AtomicFileAgentRuntimeStateStore>>>,
  AssertFalse<IsAny<ConstructorParameters<typeof localExecutor.AtomicFileAgentRuntimeStateStore>[0]>>,
  AssertFalse<IsAny<typeof localExecutor.LocalSubAgentRunnerRegistry>>,
  AssertFalse<IsAny<ConstructorParameters<typeof localExecutor.LocalSubAgentRunnerRegistry>>>,
  AssertFalse<IsAny<ConstructorParameters<typeof localExecutor.LocalSubAgentRunnerRegistry>[0]>>,
  AssertFalse<IsAny<NonNullable<ConstructorParameters<typeof localExecutor.LocalSubAgentRunnerRegistry>[0]>[number]>>,
  AssertFalse<IsAny<typeof localExecutor.MemoryAgentRuntimeStateStore>>,
  AssertFalse<IsAny<ConstructorParameters<typeof localExecutor.MemoryAgentRuntimeStateStore>>>,
  AssertFalse<IsAny<ConstructorParameters<typeof localExecutor.MemoryAgentRuntimeStateStore>[0]>>,
  AssertFalse<IsAny<typeof localExecutor.MemorySubAgentExecutor>>,
  AssertFalse<IsAny<ConstructorParameters<typeof localExecutor.MemorySubAgentExecutor>>>,
  AssertFalse<IsAny<ConstructorParameters<typeof localExecutor.MemorySubAgentExecutor>[0]>>,
  AssertFalse<IsAny<ConstructorParameters<typeof localExecutor.MemorySubAgentExecutor>[0]['registry']>>,
];

const publicValues = [
  localExecutor.AtomicFileAgentRuntimeStateStore,
  localExecutor.LocalSubAgentRunnerRegistry,
  localExecutor.MemoryAgentRuntimeStateStore,
  localExecutor.MemorySubAgentExecutor,
] as const;
declare const localContractAssertions: LocalContractAssertions;
void publicValues;
void localContractAssertions;
// @ts-expect-error The packed declaration surface must not degrade to any.
localExecutor.__maneeMissingExport;
`;
  }
  return `import packageApi = require('${packageName}');
type IsAny<T> = 0 extends 1 & T ? true : false;
type AssertFalse<T extends false> = T;
type PackageContractAssertions = [AssertFalse<IsAny<typeof packageApi>>];
declare const packageContractAssertions: PackageContractAssertions;
void packageApi;
void packageContractAssertions;
// @ts-expect-error The packed declaration surface must not degrade to any.
packageApi.__maneeMissingExport;
`;
}

function createRuntimeSmokeSource(packageName, format) {
  const load =
    format === 'esm'
      ? `const packageApi = await import('${packageName}');`
      : `const packageApi = require('${packageName}');`;
  const checks = [];
  if (packageName === '@ruixutong.manee/maneeagent-framework') {
    checks.push(
      `[packageApi.Agent, 'Agent', 'function']`,
      `[packageApi.SubAgentTransportPeer, 'SubAgentTransportPeer', 'function']`,
      `[packageApi.SubAgentTransportSequenceTracker, 'SubAgentTransportSequenceTracker', 'function']`,
      `[packageApi.createSubAgentRuntime, 'createSubAgentRuntime', 'function']`,
      `[packageApi.createSubAgentTransportArtifactSidecar, 'createSubAgentTransportArtifactSidecar', 'function']`,
      `[packageApi.createSubAgentTransportControlDispatcher, 'createSubAgentTransportControlDispatcher', 'function']`,
      `[packageApi.createSubAgentTransportPeerWriterAdmission, 'createSubAgentTransportPeerWriterAdmission', 'function']`,
      `[packageApi.createSubAgentTransportRpcEnvelope, 'createSubAgentTransportRpcEnvelope', 'function']`,
    );
    return `${load}
function expectType([value, name, expected]) {
  if (typeof value !== expected) throw new Error(\`${packageName} \${name} must be \${expected}\`);
}
for (const check of [${checks.join(', ')}]) expectType(check);
if (packageApi.SUBAGENT_TRANSPORT_VERSION !== '1') {
  throw new Error('${packageName} SUBAGENT_TRANSPORT_VERSION must equal "1"');
}
`;
  }
  if (packageName === '@ruixutong.manee/maneeagent-executor-local') {
    checks.push(
      `[packageApi.AtomicFileAgentRuntimeStateStore, 'AtomicFileAgentRuntimeStateStore', 'function']`,
      `[packageApi.LocalSubAgentRunnerRegistry, 'LocalSubAgentRunnerRegistry', 'function']`,
      `[packageApi.MemoryAgentRuntimeStateStore, 'MemoryAgentRuntimeStateStore', 'function']`,
      `[packageApi.MemorySubAgentExecutor, 'MemorySubAgentExecutor', 'function']`,
      `[packageApi.createLocalAgentRunnerRegistration, 'createLocalAgentRunnerRegistration', 'function']`,
    );
    return `${load}
function expectType([value, name, expected]) {
  if (typeof value !== expected) throw new Error(\`${packageName} \${name} must be \${expected}\`);
}
for (const check of [${checks.join(', ')}]) expectType(check);
`;
  }
  return `${load}
if ((typeof packageApi !== 'object' && typeof packageApi !== 'function') || packageApi === null) {
  throw new Error('${packageName} runtime namespace is unavailable');
}
`;
}

async function extractPackedArtifact(artifact, consumerDirectory, index) {
  assert(Buffer.isBuffer(artifact.archive), 'npm pack archive is required for consumer validation');
  const archivePath = path.join(consumerDirectory, `package-${index}.tgz`);
  const installedPackageDirectory = path.join(
    consumerDirectory,
    'node_modules',
    ...artifact.packageJson.name.split('/'),
  );
  await mkdir(installedPackageDirectory, { recursive: true });
  await writeFile(archivePath, artifact.archive);
  await runChild(
    'tar',
    ['-xzf', archivePath, '-C', installedPackageDirectory, '--strip-components=1'],
    { cwd: consumerDirectory },
    `extracting npm pack archive for ${artifact.packageJson.name} failed; a system tar executable with gzip support is required`,
  );

  let installedManifest;
  try {
    installedManifest = JSON.parse(
      (await readFile(path.join(installedPackageDirectory, 'package.json'), 'utf8')).replace(
        /^\uFEFF/u,
        '',
      ),
    );
  } catch (error) {
    throw new Error(
      `packed manifest for ${artifact.packageJson.name} is missing or invalid: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  assert(
    installedManifest.name === artifact.packageJson.name,
    `packed package name changed after extraction for ${artifact.packageJson.name}`,
  );
  assert(
    installedManifest.version === artifact.packageJson.version,
    `packed package version changed after extraction for ${artifact.packageJson.name}`,
  );
}

async function validatePackedConsumers({ artifacts, primaryArtifact }) {
  const consumerDirectory = await mkdtemp(path.join(tmpdir(), 'manee-pack-consumer-'));
  try {
    const installedPackageNames = new Set(artifacts.map((artifact) => artifact.packageJson.name));
    assert(
      installedPackageNames.size === artifacts.length,
      'packed consumer package names must be unique',
    );
    for (const [index, artifact] of artifacts.entries()) {
      await extractPackedArtifact(artifact, consumerDirectory, index);
    }

    for (const artifact of artifacts) {
      for (const [peerName, peerRange] of Object.entries(
        artifact.packageJson.peerDependencies ?? {},
      ).sort(([left], [right]) => left.localeCompare(right))) {
        assert(
          installedPackageNames.has(peerName),
          `${artifact.packageJson.name} peer ${peerName} must be supplied as a tarball from the same validation run`,
        );
        const peerArtifact = artifacts.find((candidate) => candidate.packageJson.name === peerName);
        assert(
          peerArtifact !== undefined &&
            simpleRangeAcceptsVersion(peerRange, peerArtifact.packageJson.version),
          `${artifact.packageJson.name} peer range ${peerName}@${peerRange} does not accept packed version ${String(peerArtifact?.packageJson.version)}`,
        );
      }
      const requiredDependencies = {
        ...(artifact.packageJson.dependencies ?? {}),
        ...(artifact.packageJson.peerDependencies ?? {}),
      };
      for (const dependencyName of Object.keys(requiredDependencies).sort()) {
        if (installedPackageNames.has(dependencyName)) continue;
        await linkPackage(
          path.join(consumerDirectory, 'node_modules'),
          dependencyName,
          path.join(artifact.packageDirectory, 'node_modules', ...dependencyName.split('/')),
        );
      }
    }
    await linkPackage(
      path.join(consumerDirectory, 'node_modules'),
      '@types/node',
      path.join(repoRoot, 'node_modules', '@types', 'node'),
    );

    await writeFile(
      path.join(consumerDirectory, 'package.json'),
      `${JSON.stringify({ name: 'manee-pack-consumer', private: true, type: 'module' }, null, 2)}\n`,
      'utf8',
    );
    await writeFile(
      path.join(consumerDirectory, 'consumer.ts'),
      createConsumerSource(primaryArtifact.packageJson.name),
      'utf8',
    );
    await writeFile(
      path.join(consumerDirectory, 'consumer.cts'),
      createCommonJsConsumerSource(primaryArtifact.packageJson.name),
      'utf8',
    );
    await writeFile(
      path.join(consumerDirectory, 'runtime-consumer.mjs'),
      createRuntimeSmokeSource(primaryArtifact.packageJson.name, 'esm'),
      'utf8',
    );
    await writeFile(
      path.join(consumerDirectory, 'runtime-consumer.cjs'),
      createRuntimeSmokeSource(primaryArtifact.packageJson.name, 'commonjs'),
      'utf8',
    );
    await writeFile(
      path.join(consumerDirectory, 'tsconfig.json'),
      `${JSON.stringify(
        {
          compilerOptions: {
            lib: ['ES2023'],
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            noEmit: true,
            skipLibCheck: false,
            strict: true,
            target: 'ES2023',
            types: ['node'],
            verbatimModuleSyntax: true,
          },
          include: ['consumer.ts', 'consumer.cts'],
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const typescriptCli = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
    assert(
      (await stat(typescriptCli).catch(() => null))?.isFile() === true,
      'TypeScript CLI is missing',
    );
    await runChild(
      process.execPath,
      [typescriptCli, '--project', path.join(consumerDirectory, 'tsconfig.json')],
      { cwd: consumerDirectory },
      'packed NodeNext consumer typecheck failed',
    );
    await runChild(
      process.execPath,
      [path.join(consumerDirectory, 'runtime-consumer.mjs')],
      { cwd: consumerDirectory },
      `packed ESM runtime import smoke failed for ${primaryArtifact.packageJson.name}`,
    );
    await runChild(
      process.execPath,
      [path.join(consumerDirectory, 'runtime-consumer.cjs')],
      { cwd: consumerDirectory },
      `packed CommonJS runtime require smoke failed for ${primaryArtifact.packageJson.name}`,
    );
  } finally {
    await rm(consumerDirectory, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
  }
}

function assertPublishedFile(files, target, field) {
  const normalized = normalizePackagePath(target, field);
  assert(files.has(normalized), `${field} is missing from npm pack output: ${normalized}`);
  return normalized;
}

function assertSafePackageFiles(fileList, packageName) {
  const files = new Set(fileList);
  assert(files.size === fileList.length, `${packageName} npm pack output contains duplicate paths`);
  assert(files.has('package.json'), `${packageName} npm pack output must include package.json`);
  assert(
    fileList.some((file) => /^readme(?:\.(?:markdown|md|txt))?$/iu.test(file)),
    `${packageName} npm pack output must include a root README`,
  );

  for (const file of fileList) {
    const lowerFile = file.toLowerCase();
    const segments = lowerFile.split('/');
    assert(
      lowerFile.startsWith('dist/') || ALLOWED_ROOT_FILES.has(lowerFile),
      `${packageName} npm pack output contains a forbidden top-level path: ${file}`,
    );
    if (lowerFile.startsWith('dist/')) {
      assert(
        ALLOWED_DIST_FILE_PATTERN.test(lowerFile),
        `${packageName} npm pack output contains an unsupported dist artifact: ${file}`,
      );
    }
    assert(
      !segments.some((segment) => FORBIDDEN_PATH_SEGMENTS.has(segment)),
      `${packageName} npm pack output leaks a forbidden project path: ${file}`,
    );
    assert(
      !SENSITIVE_PACKAGE_PATH_PATTERNS.some((pattern) => pattern.test(lowerFile)),
      `${packageName} npm pack output contains a secret-sensitive path: ${file}`,
    );
    assert(
      !/\.(?:cts|mts|tsx?)$/iu.test(file) || /\.d\.(?:cts|mts|ts)$/iu.test(file),
      `${packageName} npm pack output leaks TypeScript source: ${file}`,
    );
  }
  return files;
}

function parseSemver(value, field) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/u.exec(value);
  assert(match !== null, `${field} must be a simple semantic version`);
  return match.slice(1, 4).map(Number);
}

function compareSemver(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function simpleRangeAcceptsVersion(range, version) {
  const candidate = parseSemver(version, 'peer package version');
  if (range === '*' || range === version) return true;
  const match = /^(\^|~|>=)(\d+\.\d+\.\d+)$/u.exec(range);
  assert(match !== null, `unsupported peer dependency range in release gate: ${range}`);
  const lower = parseSemver(match[2], 'peer dependency range');
  if (compareSemver(candidate, lower) < 0) return false;
  if (match[1] === '>=') return true;
  if (match[1] === '~') return candidate[0] === lower[0] && candidate[1] === lower[1];
  if (lower[0] > 0) return candidate[0] === lower[0];
  if (lower[1] > 0) return candidate[0] === 0 && candidate[1] === lower[1];
  return candidate[0] === 0 && candidate[1] === 0 && candidate[2] === lower[2];
}

function assertReleaseManifest(packageJson, expectedPackageName, expectedVersion) {
  assert(
    packageJson.name === expectedPackageName,
    `package.json name ${String(packageJson.name)} does not match ${expectedPackageName}`,
  );
  assert(
    packageJson.version === expectedVersion,
    `package.json version ${String(packageJson.version)} does not match ${expectedVersion}`,
  );
  assert(packageJson.engines?.node === '>=22', 'package engines.node must be exactly >=22');
  assert(packageJson.bin === undefined, 'release packages must not publish a bin entry');
  assert(
    packageJson.exports !== null &&
      typeof packageJson.exports === 'object' &&
      !Array.isArray(packageJson.exports) &&
      Object.keys(packageJson.exports).length === 1 &&
      Object.hasOwn(packageJson.exports, '.'),
    'package exports must expose only the root "." entry',
  );
  const rootExport = packageJson.exports['.'];
  assert(
    rootExport !== null &&
      typeof rootExport === 'object' &&
      !Array.isArray(rootExport) &&
      JSON.stringify(Object.keys(rootExport).sort()) ===
        JSON.stringify(['import', 'require', 'types']),
    'root exports must contain exactly types, import and require',
  );
  const expectedContract = RELEASE_PACKAGE_CONTRACTS[expectedPackageName];
  const expectedPeers = expectedContract?.peerDependencies ?? {};
  const actualPeers = packageJson.peerDependencies ?? {};
  assert(
    JSON.stringify(actualPeers) === JSON.stringify(expectedPeers),
    `${expectedPackageName} peerDependencies differ from the release contract`,
  );
}

async function createPackageArtifact({ packageDirectory, expectedPackageName, expectedVersion }) {
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
  assertReleaseManifest(packageJson, expectedPackageName, expectedVersion);

  const { pack } = await runNpmPack(resolvedDirectory, { dryRun: true });
  assert(
    pack !== null && typeof pack === 'object' && !Array.isArray(pack),
    'npm pack result must be an object',
  );
  assert(
    pack.version === expectedVersion,
    `packed version ${String(pack.version)} does not match ${expectedVersion}`,
  );
  assert(pack.name === expectedPackageName, `packed name does not match ${expectedPackageName}`);
  assert(Array.isArray(pack.files), 'npm pack result.files must be an array');

  const fileList = pack.files.map((entry, index) =>
    normalizePackagePath(entry?.path, `npm pack files[${index}].path`),
  );
  const files = assertSafePackageFiles(fileList, packageJson.name);

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

  const actual = await runNpmPack(resolvedDirectory, { dryRun: false });
  assert(actual.pack.name === pack.name, 'actual npm pack name differs from dry-run');
  assert(actual.pack.version === pack.version, 'actual npm pack version differs from dry-run');
  assert(Array.isArray(actual.pack.files), 'actual npm pack result.files must be an array');
  const actualFiles = actual.pack.files
    .map((entry, index) =>
      normalizePackagePath(entry?.path, `actual npm pack files[${index}].path`),
    )
    .sort();
  assert(
    JSON.stringify(actualFiles) === JSON.stringify([...fileList].sort()),
    'actual npm pack file list differs from dry-run',
  );
  return {
    archive: actual.archive,
    packageDirectory: resolvedDirectory,
    packageJson,
    summary: {
      name: pack.name,
      version: pack.version,
      filename: pack.filename,
      entryCount: fileList.length,
      entries: { esm: esmPath, cjs: cjsPath, types: typesPath },
      tarballSha256: createHash('sha256').update(actual.archive).digest('hex'),
    },
  };
}

export async function validatePackageArtifact({
  packageDirectory,
  expectedPackageName,
  peerPackageDirectories = [],
  expectedVersion = '2.0.0',
}) {
  assert(
    typeof expectedPackageName === 'string' && expectedPackageName.length > 0,
    'expectedPackageName is required',
  );
  assert(Array.isArray(peerPackageDirectories), 'peerPackageDirectories must be an array');
  const primaryArtifact = await createPackageArtifact({
    packageDirectory,
    expectedPackageName,
    expectedVersion,
  });
  const peerArtifacts = [];
  for (const peerPackageDirectory of peerPackageDirectories) {
    peerArtifacts.push(
      await createPackageArtifact({
        packageDirectory: peerPackageDirectory,
        expectedPackageName:
          expectedPackageName === '@ruixutong.manee/maneeagent-executor-local'
            ? '@ruixutong.manee/maneeagent-framework'
            : expectedPackageName,
        expectedVersion,
      }),
    );
  }
  const packageNames = [
    primaryArtifact.packageJson.name,
    ...peerArtifacts.map((artifact) => artifact.packageJson.name),
  ];
  assert(new Set(packageNames).size === packageNames.length, 'packed package names must be unique');
  await validatePackedConsumers({
    artifacts: [...peerArtifacts, primaryArtifact],
    primaryArtifact,
  });

  return {
    ...primaryArtifact.summary,
    nodeNextConsumers: { commonjs: 'passed', esm: 'passed' },
    runtimeConsumers: { commonjs: 'passed', esm: 'passed' },
    packedPeers: peerArtifacts.map((artifact) => artifact.summary),
  };
}
