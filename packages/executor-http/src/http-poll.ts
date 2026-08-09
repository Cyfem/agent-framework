import { parseJsonValue } from '@ruixutong.manee/maneeagent-framework';

import {
  assertNonNegativeSafeInteger,
  copyHttpBytes,
  requireClosedDataRecord,
  type HttpBytes,
} from './http-internal';

export const HTTP_SUBAGENT_POLL_VERSION = '1';
export const HTTP_SUBAGENT_POLL_MEDIA_TYPE = 'application/vnd.maneeagent.poll+json';
export const HTTP_SUBAGENT_MAX_POLL_BODY_BYTES = 4_096;
export const HTTP_SUBAGENT_MAX_POLL_WAIT_MS = 10_000;

const POLL_COMMAND_KEYS = Object.freeze([
  'version',
  'channelId',
  'channelGeneration',
  'ackCursor',
  'waitMs',
] as const);
const POLL_INPUT_KEYS = Object.freeze(['contentType', 'body'] as const);
const CHANNEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const UINT64_DECIMAL_PATTERN = /^(?:0|[1-9][0-9]{0,19})$/u;
const UINT64_MAX_DECIMAL = '18446744073709551615';
const UTF8_BOM = Object.freeze([0xef, 0xbb, 0xbf] as const);
const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

export interface HttpSubAgentPollCommand {
  readonly version: '1';
  readonly channelId: string;
  readonly channelGeneration: string;
  readonly ackCursor: string;
  readonly waitMs: number;
}

export interface HttpSubAgentEncodedPollCommand {
  readonly contentType: string;
  readonly body: Uint8Array;
}

export interface HttpSubAgentPollInput {
  readonly contentType: string;
  readonly body: Uint8Array | ArrayBuffer;
}

/** Encodes one closed poll command using the fixed v1 field order. */
export function encodeHttpSubAgentPollCommand(
  command: HttpSubAgentPollCommand,
): HttpSubAgentEncodedPollCommand {
  const owned = ownPollCommand(command, 'HTTP poll command');
  const body = UTF8_ENCODER.encode(
    JSON.stringify({
      version: owned.version,
      channelId: owned.channelId,
      channelGeneration: owned.channelGeneration,
      ackCursor: owned.ackCursor,
      waitMs: owned.waitMs,
    }),
  );
  if (body.byteLength > HTTP_SUBAGENT_MAX_POLL_BODY_BYTES) {
    throw new RangeError('HTTP poll body exceeds the protocol byte limit.');
  }
  return Object.freeze({ contentType: HTTP_SUBAGENT_POLL_MEDIA_TYPE, body });
}

/** Strictly decodes one complete v1 poll command into an owned frozen record. */
export function decodeHttpSubAgentPollCommand(
  input: HttpSubAgentPollInput,
): HttpSubAgentPollCommand {
  const record = requireClosedDataRecord(input, POLL_INPUT_KEYS, 'HTTP poll input');
  if (record.contentType !== HTTP_SUBAGENT_POLL_MEDIA_TYPE) {
    throw new TypeError('HTTP poll contentType must be the exact v1 media type.');
  }
  const body = copyHttpBytes(
    record.body as HttpBytes,
    'HTTP poll body',
    HTTP_SUBAGENT_MAX_POLL_BODY_BYTES,
  );
  if (
    body.byteLength >= UTF8_BOM.length &&
    body[0] === UTF8_BOM[0] &&
    body[1] === UTF8_BOM[1] &&
    body[2] === UTF8_BOM[2]
  ) {
    throw new TypeError('HTTP poll body must not contain a UTF-8 BOM.');
  }

  let source: string;
  try {
    source = UTF8_DECODER.decode(body);
  } catch {
    throw new TypeError('HTTP poll body must be valid UTF-8.');
  }
  const value = parseJsonValue(source, {
    maxBytes: HTTP_SUBAGENT_MAX_POLL_BODY_BYTES,
    maxDepth: 1,
    maxNodes: POLL_COMMAND_KEYS.length + 1,
    label: 'HTTP poll body JSON',
  });
  return ownPollCommand(value, 'HTTP poll body JSON');
}

function ownPollCommand(value: unknown, label: string): HttpSubAgentPollCommand {
  const record = requireClosedDataRecord(value, POLL_COMMAND_KEYS, label);
  if (record.version !== HTTP_SUBAGENT_POLL_VERSION) {
    throw new TypeError(`${label} version must be the exact v1 version.`);
  }
  const channelId = record.channelId;
  if (typeof channelId !== 'string' || !CHANNEL_ID_PATTERN.test(channelId)) {
    throw new TypeError(`${label} channelId is not canonical.`);
  }
  const channelGeneration = requireCanonicalUint64Decimal(
    record.channelGeneration,
    `${label} channelGeneration`,
  );
  const ackCursor = requireCanonicalUint64Decimal(record.ackCursor, `${label} ackCursor`);
  const waitMs = record.waitMs;
  assertNonNegativeSafeInteger(waitMs, `${label} waitMs`);
  if (waitMs > HTTP_SUBAGENT_MAX_POLL_WAIT_MS) {
    throw new RangeError(`${label} waitMs exceeds the protocol maximum.`);
  }
  return Object.freeze({
    version: HTTP_SUBAGENT_POLL_VERSION,
    channelId,
    channelGeneration,
    ackCursor,
    waitMs,
  });
}

function requireCanonicalUint64Decimal(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !UINT64_DECIMAL_PATTERN.test(value) ||
    (value.length === UINT64_MAX_DECIMAL.length && value > UINT64_MAX_DECIMAL)
  ) {
    throw new TypeError(`${label} must be a canonical uint64 decimal string.`);
  }
  return value;
}
