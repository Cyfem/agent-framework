import {
  SubAgentRuntimeError,
  assertJsonValue,
  canonicalizeJson,
  parseJsonValue,
  type JsonValue,
  type SubAgentExecutorBindingCodec,
} from '@ruixutong.manee/maneeagent-framework';

export const PROCESS_SUBAGENT_ADAPTER_STATE_VERSION = '1' as const;
export const PROCESS_SUBAGENT_BINDING_KIND = 'maneeagent-process/v1' as const;

export interface ProcessSubAgentBindingState {
  readonly kind: typeof PROCESS_SUBAGENT_BINDING_KIND;
  readonly jobId: string;
}

export const processSubAgentBindingCodec: SubAgentExecutorBindingCodec<ProcessSubAgentBindingState> =
  Object.freeze({
    adapterStateVersion: PROCESS_SUBAGENT_ADAPTER_STATE_VERSION,
    encode: (state: ProcessSubAgentBindingState): JsonValue => ({ ...decodeProcessBinding(state) }),
    decode: decodeProcessBinding,
  });

export function decodeProcessBinding(value: unknown): ProcessSubAgentBindingState {
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
      record.kind !== PROCESS_SUBAGENT_BINDING_KIND ||
      typeof record.jobId !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(record.jobId)
    ) {
      throw invalidBinding();
    }
    return Object.freeze({ kind: PROCESS_SUBAGENT_BINDING_KIND, jobId: record.jobId });
  } catch {
    throw invalidBinding();
  }
}

function invalidBinding(): SubAgentRuntimeError {
  return new SubAgentRuntimeError({
    code: 'BINDING_INVALID',
    message: 'The Process Executor binding is invalid.',
    retryable: false,
  });
}
