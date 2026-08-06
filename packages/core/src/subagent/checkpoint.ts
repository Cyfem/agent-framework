import type { AgentProtocol, ContextOf } from '../agent/types';
import type { OpenAIChatProtocol } from '../llm/chat/types';
import type { OpenAIResponsesProtocol } from '../llm/responses/types';
import { assertJsonValue, canonicalizeJson, parseJsonValue, type JsonValue } from './json';

export type CheckpointRecordKind =
  | 'agent-run'
  | 'task'
  | 'context'
  | 'executor-binding'
  | 'child-checkpoint';

/** Self-describing protocol context stored inside a durable run checkpoint. */
export interface EncodedAgentProtocolCheckpoint {
  readonly protocol: string;
  readonly codecVersion: string;
  readonly value: JsonValue;
}

export type DurableAgentModelOperationPurpose = 'agent' | 'context-summary';
export type DurableAgentModelOperationPhase = 'prepared' | 'in_flight' | 'result_ready';

/** Protocol-neutral provider operation shared by root and child Agent checkpoints. */
export interface DurableAgentModelOperationV1 {
  readonly version: '1';
  readonly operationId: string;
  readonly iteration: number;
  readonly purpose: DurableAgentModelOperationPurpose;
  readonly requestHash: string;
  readonly phase: DurableAgentModelOperationPhase;
  readonly result?: EncodedAgentProtocolCheckpoint;
  readonly preparedAt: number;
  readonly updatedAt: number;
}

/** Strict versioned codec required for durable or cross-process restoration. */
export interface AgentProtocolCheckpointCodec<P extends AgentProtocol = AgentProtocol> {
  readonly protocol: string;
  readonly version: string;
  encode(context: readonly ContextOf<P>[]): JsonValue;
  decode(value: JsonValue): readonly ContextOf<P>[];
}

interface BaseAgentCheckpointMigrator {
  readonly fromVersion: string;
  readonly toVersion: string;
  migrate(value: JsonValue): JsonValue | Promise<JsonValue>;
}

/** Copy-on-write migration between two exact persisted schema and implementation identities. */
export type AgentCheckpointMigrator =
  | (BaseAgentCheckpointMigrator & { readonly recordKind: 'task' })
  | (BaseAgentCheckpointMigrator & {
      readonly recordKind: 'agent-run' | 'context';
      readonly protocol: string;
      readonly fromCodecVersion: string;
      readonly toCodecVersion: string;
    })
  | (BaseAgentCheckpointMigrator & {
      readonly recordKind: 'executor-binding';
      readonly executorName: string;
      readonly fromAdapterStateVersion: string;
      readonly toAdapterStateVersion: string;
    })
  | (BaseAgentCheckpointMigrator & {
      readonly recordKind: 'child-checkpoint';
      readonly runnerId: string;
      readonly fromRunnerVersion: string;
      readonly toRunnerVersion: string;
    });

export type SubAgentChildOperationKind = 'tool' | 'agent' | 'end-agent';
export type SubAgentChildOperationStatus =
  | 'prepared'
  | 'in_flight'
  | 'waiting_approval'
  | 'result_ready'
  | 'result_submitted'
  | 'applied';

/** Complete durable description of a child operation that may be replayed after suspension. */
export interface SubAgentChildOperationCheckpointV1 {
  readonly version: '1';
  readonly operationId: string;
  readonly kind: SubAgentChildOperationKind;
  readonly callId: string;
  readonly name: string;
  readonly input: JsonValue;
  readonly inputHash: string;
  readonly status: SubAgentChildOperationStatus;
  readonly order: number;
  readonly taskId?: string;
  readonly approvals?: readonly string[];
  readonly result?: JsonValue;
}

export interface SubAgentChildPendingBatchV1 {
  readonly version: '1';
  readonly batchId: string;
  readonly assistantMessage: EncodedAgentProtocolCheckpoint;
  readonly calls: readonly SubAgentChildOperationCheckpointV1[];
  readonly endRequested: boolean;
  readonly createdAt: number;
}

export interface DurableContextCompactTransactionV1 {
  readonly schemaVersion: '1';
  readonly transactionId: string;
  readonly kind: 'summary' | 'tool_payload';
  readonly contextRevision: number;
  readonly phase: 'prepared' | 'in_flight' | 'result_ready' | 'applied';
  readonly preparedAt: number;
  readonly updatedAt: number;
  /** JSON-safe deterministic rebuild metadata; never contains provider bodies or credentials. */
  readonly metadata?: JsonValue;
  readonly result?: JsonValue;
  readonly outcomeUnknown?: boolean;
}

export type SubAgentChildCompactTransactionV1 = DurableContextCompactTransactionV1;

/** Complete child loop checkpoint. A binding alone is never treated as a resumable checkpoint. */
export interface SubAgentChildCheckpointV1 {
  readonly version: '1';
  readonly runnerId: string;
  readonly runnerVersion: string;
  readonly protocolContext: EncodedAgentProtocolCheckpoint;
  readonly contextStore: ContextStoreCheckpointV1;
  readonly modelIteration: number;
  readonly maxIterations: number | null;
  readonly modelOperation?: DurableAgentModelOperationV1;
  readonly pendingBatch?: SubAgentChildPendingBatchV1;
  readonly compactTransaction?: SubAgentChildCompactTransactionV1;
  /** Minimal authoritative result projection required to resume the result-closed child phase. */
  readonly resultSubmission?: {
    readonly version: '1';
    readonly callId: string;
    readonly output: JsonValue;
    readonly outputHash: string;
  };
}

export type SubAgentChildCheckpoint = SubAgentChildCheckpointV1;

export type ContextCheckpointEntryKind =
  | 'seed'
  | 'user'
  | 'external'
  | 'loop'
  | 'summary'
  | 'preserved';

export interface ContextStoreCheckpointRawItemV1 {
  readonly itemId: string;
  readonly value: JsonValue;
}

export interface ContextStoreCheckpointEntryV1 {
  readonly entryId: string;
  readonly spanId: string;
  readonly kind: ContextCheckpointEntryKind;
  readonly active: JsonValue;
  readonly rawItemId?: string;
  readonly original?: JsonValue;
}

export interface ContextStoreCheckpointSpanV1 {
  readonly spanId: string;
  readonly kind: ContextCheckpointEntryKind;
  readonly closed: boolean;
  readonly originalContext: readonly JsonValue[];
  readonly entries: readonly ContextStoreCheckpointEntryV1[];
}

/** Stable-ID provenance checkpoint; it never relies on JavaScript object identity. */
export interface ContextStoreCheckpointV1 {
  readonly version: '1';
  /** Protocol identity checked before any persisted payload is decoded. */
  readonly protocol: string;
  /** Exact codec version checked before any persisted payload is decoded. */
  readonly codecVersion: string;
  readonly revision: number;
  readonly rawHistory: readonly ContextStoreCheckpointRawItemV1[];
  readonly activeSpans: readonly ContextStoreCheckpointSpanV1[];
  readonly summaryBoundarySpanId?: string;
  readonly previousSummary?: {
    readonly entryId: string;
    readonly text: string;
  };
  readonly openLoopSpanId?: string;
  readonly nextRawItemId: number;
  readonly nextSpanId: number;
  readonly nextEntryId: number;
}

function createJsonProtocolCheckpointCodec<P extends AgentProtocol>(
  protocol: string,
): AgentProtocolCheckpointCodec<P> {
  return Object.freeze({
    protocol,
    version: '1',
    encode(context: readonly ContextOf<P>[]): JsonValue {
      assertJsonValue(context);
      return parseJsonValue(canonicalizeJson(context));
    },
    decode(value: JsonValue): readonly ContextOf<P>[] {
      assertJsonValue(value);
      if (!Array.isArray(value)) {
        throw new TypeError(`${protocol} checkpoint must contain a context array.`);
      }
      return parseJsonValue(canonicalizeJson(value)) as unknown as readonly ContextOf<P>[];
    },
  });
}

/** Built-in version-1 Chat checkpoint codec. */
export const OPENAI_CHAT_CHECKPOINT_CODEC =
  createJsonProtocolCheckpointCodec<OpenAIChatProtocol>('openai-chat');

/** Built-in version-1 Responses checkpoint codec. */
export const OPENAI_RESPONSES_CHECKPOINT_CODEC =
  createJsonProtocolCheckpointCodec<OpenAIResponsesProtocol>('openai-responses');

export const BUILTIN_AGENT_PROTOCOL_CHECKPOINT_CODECS = Object.freeze([
  OPENAI_CHAT_CHECKPOINT_CODEC,
  OPENAI_RESPONSES_CHECKPOINT_CODEC,
] as const);
