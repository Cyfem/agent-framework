import { parseJsonValue, type JsonValue } from './json';

const textEncoder = new TextEncoder();
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

/** Internal bound for the fixed, provider-visible `agent-result` receipt JSON string. */
export const AGENT_RESULT_RECEIPT_MAX_UTF8_BYTES = 256;

interface AgentResultToolReceipt {
  readonly ok: true;
  readonly status: 'accepted' | 'replayed';
  readonly outputHash: string;
}

type AgentResultReceiptRecord = AgentResultToolReceipt & Readonly<Record<string, JsonValue>>;

/** Produces the one deterministic Tool-result representation persisted by child checkpoints. */
export function serializeAgentResultReceipt(input: {
  readonly status: AgentResultToolReceipt['status'];
  readonly outputHash: string;
}): string {
  assertReceiptStatus(input.status);
  assertOutputHash(input.outputHash);
  return JSON.stringify({ ok: true, status: input.status, outputHash: input.outputHash });
}

/** Strictly parses a persisted receipt string and links it to the authoritative result hash. */
export function parseAgentResultReceipt(
  source: unknown,
  expectedOutputHash: string,
): AgentResultToolReceipt {
  assertOutputHash(expectedOutputHash);
  if (typeof source !== 'string') {
    throw new TypeError('The agent-result Tool receipt must be a serialized JSON value.');
  }
  const byteLength = textEncoder.encode(source).byteLength;
  if (byteLength > AGENT_RESULT_RECEIPT_MAX_UTF8_BYTES) {
    throw new RangeError(
      `The agent-result Tool receipt exceeds ${AGENT_RESULT_RECEIPT_MAX_UTF8_BYTES} UTF-8 bytes.`,
    );
  }

  const value = parseJsonValue(source, {
    maxBytes: AGENT_RESULT_RECEIPT_MAX_UTF8_BYTES,
    label: 'agent-result Tool receipt',
  });
  if (!isReceiptRecord(value)) {
    throw new TypeError('The agent-result Tool receipt shape is invalid.');
  }
  assertReceiptStatus(value.status);
  assertOutputHash(value.outputHash);
  if (value.outputHash !== expectedOutputHash) {
    throw new TypeError('The agent-result Tool receipt does not match the authoritative output.');
  }
  return Object.freeze({ ok: true, status: value.status, outputHash: value.outputHash });
}

function isReceiptRecord(value: JsonValue): value is AgentResultReceiptRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Readonly<Record<string, JsonValue>>;
  const keys = Object.keys(record).sort();
  return (
    keys.length === 3 &&
    keys[0] === 'ok' &&
    keys[1] === 'outputHash' &&
    keys[2] === 'status' &&
    record.ok === true &&
    (record.status === 'accepted' || record.status === 'replayed') &&
    typeof record.outputHash === 'string'
  );
}

function assertReceiptStatus(status: unknown): asserts status is AgentResultToolReceipt['status'] {
  if (status !== 'accepted' && status !== 'replayed') {
    throw new TypeError('The agent-result Tool receipt status is invalid.');
  }
}

function assertOutputHash(outputHash: unknown): asserts outputHash is string {
  if (typeof outputHash !== 'string' || !SHA256_PATTERN.test(outputHash)) {
    throw new TypeError('The agent-result Tool receipt outputHash must be a lowercase SHA-256.');
  }
}
