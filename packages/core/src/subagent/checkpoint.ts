import type { AgentProtocol, ContextOf } from '../agent/types';
import type { OpenAIChatProtocol } from '../llm/chat/types';
import type { OpenAIResponsesProtocol } from '../llm/responses/types';
import { assertJsonValue, canonicalizeJson, parseJsonValue, type JsonValue } from './json';

export type CheckpointRecordKind = 'agent-run' | 'task' | 'context' | 'executor-binding';

/** Self-describing protocol context stored inside a durable run checkpoint. */
export interface EncodedAgentProtocolCheckpoint {
  readonly protocol: string;
  readonly codecVersion: string;
  readonly value: JsonValue;
}

/** Strict versioned codec required for durable or cross-process restoration. */
export interface AgentProtocolCheckpointCodec<P extends AgentProtocol = AgentProtocol> {
  readonly protocol: string;
  readonly version: string;
  encode(context: readonly ContextOf<P>[]): JsonValue;
  decode(value: JsonValue): readonly ContextOf<P>[];
}

/** Copy-on-write migration between two exact persisted schema versions. */
export interface AgentCheckpointMigrator {
  readonly recordKind: CheckpointRecordKind;
  readonly fromVersion: string;
  readonly toVersion: string;
  migrate(value: JsonValue): JsonValue | Promise<JsonValue>;
}

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
  readonly revision: number;
  readonly rawHistory: readonly ContextStoreCheckpointRawItemV1[];
  readonly activeSpans: readonly ContextStoreCheckpointSpanV1[];
  readonly summaryBoundarySpanId?: string;
  readonly previousSummary?: {
    readonly entryId: string;
    readonly text: string;
  };
  readonly openLoopSpanId?: string;
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
