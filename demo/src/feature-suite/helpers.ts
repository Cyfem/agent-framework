import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ArkAgentPlanConfiguration {
  readonly apiKey: string;
  readonly baseURL: string;
  readonly model: string;
}

export interface SanitizedFailure {
  readonly name: string;
  readonly status?: number;
  readonly code?: string;
  readonly type?: string;
}

const defaultArkAgentPlanBaseURL = 'https://ark.cn-beijing.volces.com/api/plan/v3';
const defaultArkAgentPlanModel = 'kimi-k3';

/** Minimal assertion helper shared by executable demos. */
export function assertFeature(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new FeatureAssertionError(message);
  }
}

/**
 * Load demo/.env without replacing explicitly exported variables.
 *
 * The caller gets the key in memory only. This helper never logs configuration values and the
 * feature-suite logger deliberately accepts only a fixed set of non-sensitive fields.
 */
export function loadArkAgentPlanConfiguration(importMetaUrl: string): ArkAgentPlanConfiguration {
  loadLocalDemoEnv(importMetaUrl);

  const apiKey = process.env.ARK_API_KEY?.trim();
  if (!apiKey) {
    throw new DemoConfigurationError(
      'missing_api_key',
      'ARK_API_KEY is required. Export it or put it in the ignored demo/.env file.',
    );
  }

  return Object.freeze({
    apiKey,
    baseURL: process.env.ARK_PLAN_BASE_URL?.trim() || defaultArkAgentPlanBaseURL,
    model: process.env.ARK_PLAN_MODEL?.trim() || defaultArkAgentPlanModel,
  });
}

/** Resolve a path relative to the demo package, independent of the process cwd. */
export function resolveDemoPath(importMetaUrl: string, ...segments: string[]): string {
  const currentFile = fileURLToPath(importMetaUrl);
  return resolve(dirname(currentFile), '../..', ...segments);
}

/** Emit one JSON line containing only explicitly supplied, non-sensitive telemetry. */
export function logFeatureEvent(
  scenario: 'chat' | 'responses' | 'suite',
  phase: 'start' | 'model' | 'tool' | 'passed' | 'failed',
  details: Readonly<
    Partial<{
      purpose: 'agent' | 'context-summary';
      tool: string;
      tools: number;
      messages: number;
      rawChars: number;
      activeChars: number;
      status: number | 'ok';
      code: string;
      errorType: string;
      failedScenarios: number;
    }>
  > = {},
): void {
  console.log(JSON.stringify({ scenario, phase, ...details }));
}

/** Reduce provider failures to stable metadata; never surface message, request, headers, or body. */
export function sanitizeFailure(error: unknown): SanitizedFailure {
  if (!isRecord(error)) {
    return { name: 'UnknownError' };
  }

  const failure: {
    name: string;
    status?: number;
    code?: string;
    type?: string;
  } = {
    name: typeof error.name === 'string' ? error.name : 'Error',
  };

  if (typeof error.status === 'number' && Number.isFinite(error.status)) {
    failure.status = error.status;
  }

  if (typeof error.code === 'string') {
    failure.code = error.code;
  }

  if (typeof error.type === 'string') {
    failure.type = error.type;
  }

  return failure;
}

export class FeatureAssertionError extends Error {
  readonly code = 'feature_assertion_failed';

  constructor(message: string) {
    super(message);
    this.name = 'FeatureAssertionError';
  }
}

export class DemoConfigurationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DemoConfigurationError';
  }
}

function loadLocalDemoEnv(importMetaUrl: string): void {
  const envPath = resolveDemoPath(importMetaUrl, '.env');
  if (!existsSync(envPath)) {
    return;
  }

  for (const sourceLine of readFileSync(envPath, 'utf8').split(/\r?\n/u)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const separator = line.indexOf('=');
    if (separator < 1) {
      continue;
    }

    const name = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || process.env[name] !== undefined) {
      continue;
    }

    process.env[name] = unwrapEnvValue(line.slice(separator + 1).trim());
  }
}

function unwrapEnvValue(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value.at(-1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
