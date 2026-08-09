import { Buffer } from 'node:buffer';
import { createHash, createHmac } from 'node:crypto';

import {
  createSubAgentTransportArtifactSidecar,
  createSubAgentTransportRpcEnvelope,
  encodeSubAgentTransportRpcFrame,
  type ArtifactReference,
  type SubAgentTransportPeerPacket,
} from '@ruixutong.manee/maneeagent-framework';

export const HTTP_TEST_NOW = 1_800_000_000_000;
export const HTTP_TEST_KEY_ID = 'http-test-key';
export const HTTP_TEST_KEY = Uint8Array.from({ length: 32 }, (_value, index) => index + 1);
export const HTTP_TEST_REQUEST_TARGET = '/v1/jobs/http-job-1/poll';
export const HTTP_TEST_OWNER_SESSION_ID = 'owner-session-http-1';

export function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function text(value: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(value);
}

export function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hmacSignature(input: {
  readonly key?: Uint8Array;
  readonly keyId: string;
  readonly timestamp: string;
  readonly nonce: string;
  readonly method: string;
  readonly requestTarget: string;
  readonly bodyDigest: string;
  readonly canonicalOverride?: string;
  readonly canonicalSuffix?: string;
}): string {
  const canonical =
    input.canonicalOverride ??
    [
      'MANEE-HMAC-SHA256-V1',
      input.keyId,
      input.timestamp,
      input.nonce,
      input.method,
      input.requestTarget,
      input.bodyDigest,
    ].join('\n');
  return createHmac('sha256', input.key ?? HTTP_TEST_KEY)
    .update(`${canonical}${input.canonicalSuffix ?? ''}`, 'utf8')
    .digest('base64url');
}

export function nonce(fill: number): string {
  return Buffer.alloc(16, fill).toString('base64url');
}

export function createRpcFrame(
  options: {
    readonly channelId?: string;
    readonly messageId?: string;
    readonly taskId?: string;
    readonly operationId?: string;
  } = {},
): string {
  return encodeSubAgentTransportRpcFrame(
    createSubAgentTransportRpcEnvelope({
      channelId: options.channelId ?? 'http-channel-1',
      sequence: 1,
      messageId: options.messageId ?? 'http-message-1',
      taskId: options.taskId ?? 'http-task-1',
      operationId: options.operationId ?? 'http-operation-1',
      kind: 'snapshot.request',
      payload: { mode: 'snapshot' },
    }),
  );
}

export function createSidecar(
  sidecarId: string,
  data: Uint8Array,
  mediaType = 'application/octet-stream',
): ReturnType<typeof createSubAgentTransportArtifactSidecar> {
  const digest = sha256(data);
  const artifact: ArtifactReference = {
    version: '1',
    id: `artifact-${sidecarId}`,
    mediaType,
    size: data.byteLength,
    sha256: digest,
  };
  return createSubAgentTransportArtifactSidecar({ sidecarId, artifact, data });
}

export function createPacket(sidecarData: readonly Uint8Array[] = []): SubAgentTransportPeerPacket {
  return Object.freeze({
    frame: createRpcFrame(),
    sidecars: Object.freeze(
      sidecarData.map((data, index) => createSidecar(`http-sidecar-${index + 1}`, data)),
    ),
  });
}

export function findRawHeader(rawHeaders: readonly string[], name: string): string {
  const normalized = name.toLowerCase();
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === normalized) {
      const value = rawHeaders[index + 1];
      if (value !== undefined) return value;
    }
  }
  throw new Error(`Missing test header ${name}.`);
}

export function replaceRawHeader(
  rawHeaders: readonly string[],
  name: string,
  value: string,
): readonly string[] {
  const replaced = [...rawHeaders];
  const normalized = name.toLowerCase();
  for (let index = 0; index < replaced.length; index += 2) {
    if (replaced[index]?.toLowerCase() === normalized) {
      replaced[index + 1] = value;
      return replaced;
    }
  }
  throw new Error(`Missing test header ${name}.`);
}

export function removeRawHeader(rawHeaders: readonly string[], name: string): readonly string[] {
  const normalized = name.toLowerCase();
  const filtered: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() !== normalized) {
      filtered.push(rawHeaders[index]!, rawHeaders[index + 1]!);
    }
  }
  return filtered;
}

export function appendRawHeader(
  rawHeaders: readonly string[],
  name: string,
  value: string,
): readonly string[] {
  return [...rawHeaders, name, value];
}

export function replaceBytes(source: Uint8Array, search: string, replacement: string): Uint8Array {
  const needle = bytes(search);
  const offset = indexOfByteSequence(source, needle);
  if (offset < 0) {
    throw new Error(`Missing test byte sequence ${JSON.stringify(search)}.`);
  }
  return concatBytes(
    source.subarray(0, offset),
    bytes(replacement),
    source.subarray(offset + needle.byteLength),
  );
}

export function concatBytes(...chunks: readonly Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export function mutateFirstByte(source: Uint8Array, search: string): Uint8Array {
  const needle = bytes(search);
  const result = Uint8Array.from(source);
  outer: for (let offset = 0; offset <= result.byteLength - needle.byteLength; offset += 1) {
    for (let index = 0; index < needle.byteLength; index += 1) {
      if (result[offset + index] !== needle[index]) continue outer;
    }
    result[offset] = result[offset]! ^ 1;
    return result;
  }
  throw new Error(`Missing test byte sequence ${JSON.stringify(search)}.`);
}

export interface EncodedMultipartFixture {
  readonly contentType: string;
  readonly body: Uint8Array;
}

export function multipartBoundary(contentType: string): string {
  const match = /^multipart\/mixed; boundary=([A-Za-z0-9'()+_,./:=?-]+)$/u.exec(contentType);
  if (match?.[1] === undefined) {
    throw new Error(`Unexpected test multipart content type ${JSON.stringify(contentType)}.`);
  }
  return match[1];
}

export function packetJson(encoded: EncodedMultipartFixture): string {
  const separator = bytes('\r\n\r\n');
  const bodyStart = indexOfByteSequence(encoded.body, separator);
  const closing = bytes(`\r\n--${multipartBoundary(encoded.contentType)}`);
  const bodyEnd = indexOfByteSequence(encoded.body, closing, bodyStart + separator.byteLength);
  if (bodyStart < 0 || bodyEnd < 0) {
    throw new Error('The encoded multipart fixture does not contain a first-part body.');
  }
  return text(encoded.body.subarray(bodyStart + separator.byteLength, bodyEnd));
}

export function replacePacketJson(
  encoded: EncodedMultipartFixture,
  replacement: string,
): EncodedMultipartFixture {
  return {
    contentType: encoded.contentType,
    body: replaceBytes(encoded.body, packetJson(encoded), replacement),
  };
}

export function rawHeadersFromRecord(headers: Readonly<Record<string, string>>): readonly string[] {
  return Object.entries(headers).flatMap(([name, value]) => [name, value]);
}

function indexOfByteSequence(source: Uint8Array, needle: Uint8Array, start = 0): number {
  if (needle.byteLength === 0) return start <= source.byteLength ? start : -1;
  outer: for (
    let offset = Math.max(0, start);
    offset <= source.byteLength - needle.byteLength;
    offset += 1
  ) {
    for (let index = 0; index < needle.byteLength; index += 1) {
      if (source[offset + index] !== needle[index]) continue outer;
    }
    return offset;
  }
  return -1;
}
