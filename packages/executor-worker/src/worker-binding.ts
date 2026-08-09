import {
  SubAgentRuntimeError,
  assertJsonValue,
  canonicalizeJson,
  parseJsonValue,
  type JsonValue,
  type SubAgentExecutorBindingCodec,
} from '@ruixutong.manee/maneeagent-framework';

export const WORKER_SUBAGENT_ADAPTER_STATE_VERSION = '1' as const;
export const WORKER_SUBAGENT_BINDING_KIND = 'maneeagent-worker/v1' as const;

export interface WorkerSubAgentBindingState {
  readonly kind: typeof WORKER_SUBAGENT_BINDING_KIND;
  readonly jobId: string;
}

export const workerSubAgentBindingCodec: SubAgentExecutorBindingCodec<WorkerSubAgentBindingState> =
  Object.freeze({
    adapterStateVersion: WORKER_SUBAGENT_ADAPTER_STATE_VERSION,
    encode: (state: WorkerSubAgentBindingState): JsonValue => ({ ...decodeWorkerBinding(state) }),
    decode: decodeWorkerBinding,
  });

export function decodeWorkerBinding(value: unknown): WorkerSubAgentBindingState {
  try {
    assertJsonValue(value);
    const owned = parseJsonValue(canonicalizeJson(value));
    if (
      typeof owned !== 'object' ||
      owned === null ||
      Array.isArray(owned) ||
      Object.keys(owned).sort().join(',') !== 'jobId,kind'
    ) {
      throw invalidBinding();
    }
    const record = owned as { readonly jobId?: unknown; readonly kind?: unknown };
    if (
      record.kind !== WORKER_SUBAGENT_BINDING_KIND ||
      typeof record.jobId !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(record.jobId)
    ) {
      throw invalidBinding();
    }
    return Object.freeze({ kind: WORKER_SUBAGENT_BINDING_KIND, jobId: record.jobId });
  } catch {
    throw invalidBinding();
  }
}

function invalidBinding(): SubAgentRuntimeError {
  return new SubAgentRuntimeError({
    code: 'BINDING_INVALID',
    message: 'The Worker Executor binding is invalid.',
    retryable: false,
  });
}
