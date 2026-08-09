import { describe, expect } from 'vitest';

import { ManualClock, acceptanceIt } from '../../../testkit';

import {
  DEFAULT_SUBAGENT_TRANSPORT_MAX_FRAME_BYTES,
  DEFAULT_SUBAGENT_TRANSPORT_MAX_JSON_DEPTH,
  DEFAULT_SUBAGENT_TRANSPORT_MAX_JSON_NODES,
  DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECAR_BYTES,
  DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECAR_ITEM_BYTES,
  DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECARS,
  decodeSubAgentTransportArtifactSidecar,
  type SubAgentTransportPeerPacket,
} from '@ruixutong.manee/maneeagent-framework';

import {
  HTTP_SUBAGENT_MAX_MULTIPART_BODY_BYTES,
  HTTP_SUBAGENT_MAX_PACKET_JSON_BYTES,
  HTTP_SUBAGENT_MAX_PART_HEADER_BYTES,
  MemoryHttpSubAgentReplayCache,
  admitHttpSubAgentPacket,
  createHttpSubAgentHmacHeaders,
  createHttpSubAgentHmacVerifier,
  decodeHttpSubAgentMultipartPacket,
  encodeHttpSubAgentMultipartPacket,
} from '../src/index';
import { parseHttpSubAgentRoute } from '../src/http-route';
import type { HttpSubAgentMultipartLimits } from '../src/multipart';
import {
  bytes,
  concatBytes,
  createPacket,
  HTTP_TEST_KEY,
  HTTP_TEST_KEY_ID,
  HTTP_TEST_NOW,
  HTTP_TEST_OWNER_SESSION_ID,
  HTTP_TEST_REQUEST_TARGET,
  multipartBoundary,
  nonce,
  packetJson,
  rawHeadersFromRecord,
  replaceBytes,
  replacePacketJson,
  sha256,
  text,
  type EncodedMultipartFixture,
} from './http-security-fixture';
import { assertNetworkDenyGuardInstalled } from './network-deny.setup';

interface PacketJsonFixture {
  readonly version: '1';
  readonly frame: string;
  readonly sidecars: readonly Record<string, unknown>[];
}

function decode(encoded: EncodedMultipartFixture, limits?: HttpSubAgentMultipartLimits) {
  return decodeHttpSubAgentMultipartPacket(encoded, limits);
}

function parsePacketJson(encoded: EncodedMultipartFixture): PacketJsonFixture {
  return JSON.parse(packetJson(encoded)) as PacketJsonFixture;
}

function multipartSegments(encoded: EncodedMultipartFixture): readonly string[] {
  return text(encoded.body).split(`--${multipartBoundary(encoded.contentType)}`);
}

function withMultipartSegments(
  encoded: EncodedMultipartFixture,
  segments: readonly string[],
): EncodedMultipartFixture {
  return {
    contentType: encoded.contentType,
    body: bytes(segments.join(`--${multipartBoundary(encoded.contentType)}`)),
  };
}

function expectRejected(
  encoded: EncodedMultipartFixture,
  limits?: HttpSubAgentMultipartLimits,
): void {
  expect(() => decode(encoded, limits)).toThrow();
}

async function probeAdmission(input: {
  readonly contentType: string;
  readonly requestBody: Uint8Array;
  readonly signedBody?: Uint8Array;
  readonly requestTarget?: string;
  readonly nonce: string;
}) {
  const clock = new ManualClock(HTTP_TEST_NOW);
  const replayCache = new MemoryHttpSubAgentReplayCache({
    mode: 'loopback-test',
    now: clock.now,
  });
  const counters = { owner: 0, authorize: 0, onPacket: 0 };
  const requestTarget = input.requestTarget ?? HTTP_TEST_REQUEST_TARGET;
  const headers = createHttpSubAgentHmacHeaders({
    method: 'POST',
    requestTarget,
    body: input.signedBody ?? input.requestBody,
    keyId: HTTP_TEST_KEY_ID,
    key: HTTP_TEST_KEY,
    timestamp: HTTP_TEST_NOW,
    nonce: input.nonce,
  });
  const request = {
    method: 'POST',
    requestTarget,
    rawHeaders: ['Content-Type', input.contentType, ...rawHeadersFromRecord(headers)],
    body: input.requestBody,
    transport: {
      tls: false,
      loopback: true,
      requestTargetPreserved: true,
      redirectCount: 0,
    },
  } as const;
  const options = {
    securityPolicy: { mode: 'loopback-test' },
    now: clock.now,
    keyResolver: (keyId: string) =>
      keyId === HTTP_TEST_KEY_ID
        ? { principalId: 'http-multipart-test-principal', key: HTTP_TEST_KEY }
        : undefined,
    replayCache,
    resolveOwnerSessionId: () => {
      counters.owner += 1;
      return HTTP_TEST_OWNER_SESSION_ID;
    },
    authorize: () => {
      counters.authorize += 1;
      return true;
    },
    onPacket: () => {
      counters.onPacket += 1;
    },
  } as const;
  return {
    request,
    options,
    counters,
    result: await admitHttpSubAgentPacket(request, options),
  };
}

describe('HTTP single-packet multipart boundary', () => {
  acceptanceIt('C7C-HTTP-MP01.l1.closed-packet-json', 'closed-first-part-and-json-bounds', () => {
    assertNetworkDenyGuardInstalled();
    const encoded = encodeHttpSubAgentMultipartPacket(createPacket());
    const decoded = decode(encoded);

    expect(decoded.frame).toBe(parsePacketJson(encoded).frame);
    expect(decoded.sidecars).toEqual([]);
    expect(Object.isFrozen(decoded)).toBe(true);

    for (const contentType of [
      'application/json',
      'multipart/mixed',
      'multipart/mixed; boundary=',
      'multipart/mixed; boundary=wrong-boundary',
      `${encoded.contentType}; charset=utf-8`,
    ]) {
      expectRejected({ ...encoded, contentType });
    }

    expectRejected({
      ...encoded,
      body: replaceBytes(
        encoded.body,
        'Content-Type: application/vnd.maneeagent.packet+json',
        'Content-Type: application/json',
      ),
    });

    const packet = parsePacketJson(encoded);
    expect(packet.frame).toBe(String(createPacket().frame));
    const invalidPacketJson = [
      JSON.stringify({ frame: packet.frame, sidecars: packet.sidecars }),
      JSON.stringify({ version: '1', sidecars: packet.sidecars }),
      JSON.stringify({ version: '1', frame: packet.frame }),
      JSON.stringify({ ...packet, extra: true }),
      JSON.stringify({ ...packet, version: '2' }),
      JSON.stringify({ ...packet, frame: { nested: 'not-a-string' } }),
      `{"version":"1","version":"1","frame":${JSON.stringify(packet.frame)},"sidecars":[]}`,
    ];
    for (const invalid of invalidPacketJson) {
      expectRejected(replacePacketJson(encoded, invalid));
    }

    expectRejected(replacePacketJson(encoded, `${packetJson(encoded)} trailing`));
    expectRejected(replacePacketJson(encoded, '{'));
    expectRejected(encoded, { maxJsonDepth: 1 });
    expectRejected(encoded, { maxJsonNodes: 1 });

    const rpc = JSON.parse(packet.frame) as Record<string, unknown>;
    for (const invalidFrame of [
      '{}',
      JSON.stringify({ ...rpc, kind: 'unknown.kind' }),
      JSON.stringify({ ...rpc, extra: true }),
    ]) {
      expectRejected(
        replacePacketJson(encoded, JSON.stringify({ ...packet, frame: invalidFrame })),
      );
    }
  });

  acceptanceIt(
    'C7C-HTTP-MP02.l2.atomic-sidecar-parts',
    'ordered-header-allowlist-and-cleanup',
    () => {
      const encoded = encodeHttpSubAgentMultipartPacket(
        createPacket([bytes('FIRST-SIDECAR'), bytes('SECOND-SIDECAR')]),
      );
      const decoded = decode(encoded);
      expect(decoded.sidecars.map((sidecar) => text(sidecar.data))).toEqual([
        'FIRST-SIDECAR',
        'SECOND-SIDECAR',
      ]);
      const zeroLength = decode(
        encodeHttpSubAgentMultipartPacket(createPacket([new Uint8Array(0)])),
      );
      expect(zeroLength.sidecars).toHaveLength(1);
      expect(zeroLength.sidecars[0]!.data).toHaveLength(0);

      const segments = multipartSegments(encoded);
      expect(segments).toHaveLength(5);
      for (const invalidSegments of [
        [segments[0]!, segments[1]!, segments[2]!, segments[4]!],
        [segments[0]!, segments[1]!, segments[2]!, segments[3]!, segments[3]!, segments[4]!],
        [segments[0]!, segments[1]!, segments[3]!, segments[2]!, segments[4]!],
      ]) {
        expectRejected(withMultipartSegments(encoded, invalidSegments));
      }

      const headerMutations = [
        ['Content-ID: http-sidecar-2', 'Content-ID: http-sidecar-1'],
        ['Content-ID: http-sidecar-2', 'Content-ID: unknown-sidecar'],
        ['Content-Type: application/octet-stream', 'Content-Type: text/plain'],
        ['Content-Type: application/octet-stream', 'content-type: application/octet-stream'],
        ['Content-ID: http-sidecar-1', 'Content-Id: http-sidecar-1'],
        ['Content-ID: http-sidecar-1', 'Content-ID:  http-sidecar-1'],
        [
          'Content-Type: application/octet-stream',
          'Content-Type: multipart/mixed; boundary=nested',
        ],
        [
          'Content-Type: application/octet-stream',
          'Content-Type: application/octet-stream\r\nContent-Transfer-Encoding: base64',
        ],
        [
          'Content-Type: application/octet-stream',
          'Content-Type: application/octet-stream\r\nX-Unknown-Part-Header: rejected',
        ],
      ] as const;
      for (const [search, replacement] of headerMutations) {
        expectRejected({ ...encoded, body: replaceBytes(encoded.body, search, replacement) });
      }

      expectRejected({
        ...encoded,
        body: replaceBytes(encoded.body, 'FIRST-SIDECAR', ''),
      });
      for (const [search, replacement] of [
        ['Content-ID: http-sidecar-1\r\n', ''],
        [
          'Content-ID: http-sidecar-1\r\n',
          'Content-ID: http-sidecar-1\r\nContent-ID: http-sidecar-1\r\n',
        ],
        ['Content-Type: application/octet-stream\r\n', ''],
        [
          'Content-Type: application/octet-stream\r\n',
          'Content-Type: application/octet-stream\r\nContent-Type: application/octet-stream\r\n',
        ],
        [
          'Content-Type: application/octet-stream\r\nContent-ID: http-sidecar-1',
          'Content-ID: http-sidecar-1\r\nContent-Type: application/octet-stream',
        ],
        [
          'Content-ID: http-sidecar-1\r\n\r\nFIRST-SIDECAR',
          'Content-ID: http-sidecar-1\r\n\r\n\r\nFIRST-SIDECAR',
        ],
        [
          'Content-Type: application/vnd.maneeagent.packet+json\r\n\r\n',
          'Content-Type: application/vnd.maneeagent.packet+json\r\nX-Unknown: no\r\n\r\n',
        ],
        [
          'Content-Type: application/vnd.maneeagent.packet+json\r\n\r\n',
          'Content-Type: application/vnd.maneeagent.packet+json\r\nContent-Type: application/vnd.maneeagent.packet+json\r\n\r\n',
        ],
      ] as const) {
        expectRejected({ ...encoded, body: replaceBytes(encoded.body, search, replacement) });
      }

      const packet = parsePacketJson(encoded);
      expectRejected(
        replacePacketJson(
          encoded,
          JSON.stringify({ ...packet, sidecars: [...packet.sidecars, packet.sidecars[0]] }),
        ),
      );
      expectRejected(replacePacketJson(encoded, JSON.stringify({ ...packet, sidecars: [] })));

      const collisionSeed = encodeHttpSubAgentMultipartPacket(
        createPacket([bytes('x'.repeat(256))]),
      );
      const collisionMarker = `prefix\r\n--${multipartBoundary(collisionSeed.contentType)}\r\nsuffix`;
      const collisionData = bytes(collisionMarker.padEnd(256, 'y'));
      const collisionPacket = parsePacketJson(collisionSeed);
      const collisionDescriptor = collisionPacket.sidecars[0]!;
      const collisionDigest = sha256(collisionData);
      const collisionBody = replaceBytes(collisionSeed.body, 'x'.repeat(256), text(collisionData));
      const collisionEncoded = replacePacketJson(
        { ...collisionSeed, body: collisionBody },
        JSON.stringify({
          ...collisionPacket,
          sidecars: [
            {
              ...collisionDescriptor,
              sha256: collisionDigest,
              artifact: {
                ...(collisionDescriptor.artifact as Record<string, unknown>),
                sha256: collisionDigest,
              },
            },
          ],
        }),
      );
      expect(text(decode(collisionEncoded).sidecars[0]!.data)).toBe(text(collisionData));
    },
  );

  acceptanceIt('C7C-HTTP-MP03.l2.multipart-byte-limits', 'exact-boundaries-and-plus-one', () => {
    expect(DEFAULT_SUBAGENT_TRANSPORT_MAX_FRAME_BYTES).toBe(16 * 1024 * 1024);
    expect(DEFAULT_SUBAGENT_TRANSPORT_MAX_JSON_DEPTH).toBe(128);
    expect(DEFAULT_SUBAGENT_TRANSPORT_MAX_JSON_NODES).toBe(1_000_000);
    expect(DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECAR_ITEM_BYTES).toBe(32 * 1024 * 1024);
    expect(DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECARS).toBe(8);
    expect(DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECAR_BYTES).toBe(128 * 1024 * 1024);
    expect(HTTP_SUBAGENT_MAX_MULTIPART_BODY_BYTES).toBe(161 * 1024 * 1024);
    expect(HTTP_SUBAGENT_MAX_PART_HEADER_BYTES).toBe(16 * 1024);
    expect(HTTP_SUBAGENT_MAX_PACKET_JSON_BYTES).toBe(32 * 1024 * 1024 + 64 * 1024);

    const limits = {
      maxSidecarItemBytes: 4,
      maxSidecars: 2,
      maxSidecarBytes: 8,
    };
    const exact = encodeHttpSubAgentMultipartPacket(
      createPacket([bytes('ABCD'), bytes('EFGH')]),
      limits,
    );
    expect(decode(exact, limits).sidecars.map((sidecar) => sidecar.data.byteLength)).toEqual([
      4, 4,
    ]);

    const overItem = createPacket([bytes('ABCDE')]).sidecars[0]!;
    expect(() =>
      decodeSubAgentTransportArtifactSidecar(overItem.descriptor, overItem.data, { maxBytes: 4 }),
    ).toThrow();
    expect(() =>
      encodeHttpSubAgentMultipartPacket(
        { frame: createPacket().frame, sidecars: [overItem] },
        limits,
      ),
    ).toThrow();
    expect(() =>
      encodeHttpSubAgentMultipartPacket(createPacket([bytes('A'), bytes('B'), bytes('C')]), limits),
    ).toThrow();
    expect(() =>
      encodeHttpSubAgentMultipartPacket(createPacket([bytes('ABCD'), bytes('EFGHI')]), {
        ...limits,
        maxSidecarItemBytes: 5,
      }),
    ).toThrow();

    expect(() => decode(exact, { ...limits, maxBodyBytes: exact.body.byteLength })).not.toThrow();
    expectRejected(exact, { ...limits, maxBodyBytes: exact.body.byteLength - 1 });
    expectRejected({ ...exact, body: exact.body.subarray(0, exact.body.byteLength - 1) }, limits);
    expectRejected({ ...exact, body: concatBytes(exact.body, bytes('x')) }, limits);
    expectRejected({ ...exact, body: replaceBytes(exact.body, 'ABCD', 'XBCD') }, limits);

    const frameBytes = bytes(String(createPacket().frame)).byteLength;
    expect(() =>
      encodeHttpSubAgentMultipartPacket(createPacket(), { maxFrameBytes: frameBytes }),
    ).not.toThrow();
    expect(() =>
      encodeHttpSubAgentMultipartPacket(createPacket(), { maxFrameBytes: frameBytes - 1 }),
    ).toThrow();

    const deterministic = encodeHttpSubAgentMultipartPacket(createPacket(), {
      boundary: `a${'b'.repeat(69)}`,
    });
    expect(multipartBoundary(deterministic.contentType)).toHaveLength(70);
    expect(() =>
      encodeHttpSubAgentMultipartPacket(createPacket(), {
        boundary: `a${'b'.repeat(70)}`,
      }),
    ).toThrow();
    for (const boundary of ['', '-leading', 'contains space', 'contains\rcontrol', '边界']) {
      expect(() => encodeHttpSubAgentMultipartPacket(createPacket(), { boundary })).toThrow();
    }

    const firstHeaderBytes = bytes(
      'Content-Type: application/vnd.maneeagent.packet+json',
    ).byteLength;
    const shortBoundary = encodeHttpSubAgentMultipartPacket(createPacket(), { boundary: 'b' });
    expect(() => decode(shortBoundary, { maxHeaderBytes: firstHeaderBytes })).not.toThrow();
    expectRejected(shortBoundary, { maxHeaderBytes: firstHeaderBytes - 1 });
    const exactPacketJsonBytes = bytes(packetJson(shortBoundary)).byteLength;
    expect(() => decode(shortBoundary, { maxPacketJsonBytes: exactPacketJsonBytes })).not.toThrow();
    expectRejected(shortBoundary, { maxPacketJsonBytes: exactPacketJsonBytes - 1 });

    const findMinimumPassingLimit = (
      field: 'maxJsonDepth' | 'maxJsonNodes',
      maximum: number,
    ): number => {
      for (let value = 0; value <= maximum; value += 1) {
        try {
          decode(shortBoundary, { [field]: value });
          return value;
        } catch {
          // Both the packet JSON and its embedded strict RPC frame must fit.
        }
      }
      throw new Error(`No passing ${field} test boundary was found.`);
    };
    const exactDepth = findMinimumPassingLimit('maxJsonDepth', 128);
    expect(() => decode(shortBoundary, { maxJsonDepth: exactDepth })).not.toThrow();
    expectRejected(shortBoundary, { maxJsonDepth: exactDepth - 1 });
    const exactNodes = findMinimumPassingLimit('maxJsonNodes', 256);
    expect(() => decode(shortBoundary, { maxJsonNodes: exactNodes })).not.toThrow();
    expectRejected(shortBoundary, { maxJsonNodes: exactNodes - 1 });

    for (const field of [
      'maxBodyBytes',
      'maxHeaderBytes',
      'maxPacketJsonBytes',
      'maxFrameBytes',
      'maxSidecarItemBytes',
      'maxJsonNodes',
    ] as const) {
      expect(() => encodeHttpSubAgentMultipartPacket(createPacket(), { [field]: 0 })).toThrow();
    }
    for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        encodeHttpSubAgentMultipartPacket(createPacket(), { maxBodyBytes: value }),
      ).toThrow();
    }
    expect(() =>
      encodeHttpSubAgentMultipartPacket(createPacket(), {
        unknownLimit: 1,
      } as HttpSubAgentMultipartLimits),
    ).toThrow();
    expect(() =>
      encodeHttpSubAgentMultipartPacket(createPacket(), {
        maxTotalSidecarBytes: 8,
      } as HttpSubAgentMultipartLimits),
    ).toThrow();
    for (const [field, value] of [
      ['maxBodyBytes', HTTP_SUBAGENT_MAX_MULTIPART_BODY_BYTES + 1],
      ['maxHeaderBytes', HTTP_SUBAGENT_MAX_PART_HEADER_BYTES + 1],
      ['maxPacketJsonBytes', HTTP_SUBAGENT_MAX_PACKET_JSON_BYTES + 1],
      ['maxFrameBytes', DEFAULT_SUBAGENT_TRANSPORT_MAX_FRAME_BYTES + 1],
      ['maxSidecars', DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECARS + 1],
      ['maxSidecarItemBytes', DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECAR_ITEM_BYTES + 1],
      ['maxSidecarBytes', DEFAULT_SUBAGENT_TRANSPORT_PEER_MAX_SIDECAR_BYTES + 1],
      ['maxJsonDepth', DEFAULT_SUBAGENT_TRANSPORT_MAX_JSON_DEPTH + 1],
      ['maxJsonNodes', DEFAULT_SUBAGENT_TRANSPORT_MAX_JSON_NODES + 1],
    ] as const) {
      expect(() => encodeHttpSubAgentMultipartPacket(createPacket(), { [field]: value })).toThrow();
    }

    expect(() =>
      encodeHttpSubAgentMultipartPacket(
        createPacket(),
        new Proxy({}, {}) as HttpSubAgentMultipartLimits,
      ),
    ).toThrow();
    let limitGetterCalls = 0;
    const accessorLimits = Object.defineProperty({}, 'maxBodyBytes', {
      configurable: true,
      enumerable: true,
      get: () => {
        limitGetterCalls += 1;
        return 1;
      },
    }) as HttpSubAgentMultipartLimits;
    expect(() => encodeHttpSubAgentMultipartPacket(createPacket(), accessorLimits)).toThrow();
    expect(limitGetterCalls).toBe(0);
    const symbolicLimits = {} as Record<PropertyKey, unknown>;
    symbolicLimits[Symbol('unknown-limit')] = 1;
    expect(() =>
      encodeHttpSubAgentMultipartPacket(
        createPacket(),
        symbolicLimits as HttpSubAgentMultipartLimits,
      ),
    ).toThrow();

    const declared = parsePacketJson(exact);
    const first = declared.sidecars[0]!;
    expectRejected(
      replacePacketJson(
        exact,
        JSON.stringify({
          ...declared,
          sidecars: [{ ...first, byteLength: 3 }, ...declared.sidecars.slice(1)],
        }),
      ),
      limits,
    );
  });

  acceptanceIt(
    'C7C-HTTP-MP04.l2.owned-copy-body-integrity',
    'mutation-and-raw-byte-tamper',
    async () => {
      const packet = createPacket([bytes('OWNED-SIDECAR-PROOF')]);
      const encoded = encodeHttpSubAgentMultipartPacket(packet);
      const bodyBeforeMutation = Uint8Array.from(encoded.body);
      packet.sidecars[0]!.data.fill(0);
      expect(encoded.body).toEqual(bodyBeforeMutation);

      const firstDecode = decode(encoded);
      const decodedBeforeMutation = Uint8Array.from(firstDecode.sidecars[0]!.data);
      firstDecode.sidecars[0]!.data.fill(0);
      expect(decode(encoded).sidecars[0]!.data).toEqual(decodedBeforeMutation);

      const proxiedBytes = new Proxy(Uint8Array.from([1, 2, 3]), {});
      const descriptor = createPacket([Uint8Array.from([1, 2, 3])]).sidecars[0]!.descriptor;
      expect(() =>
        encodeHttpSubAgentMultipartPacket({
          frame: packet.frame,
          sidecars: [{ descriptor, data: proxiedBytes }],
        } as SubAgentTransportPeerPacket),
      ).toThrow();

      const forgedBytes = Object.create(Uint8Array.prototype) as Uint8Array;
      expect(() =>
        encodeHttpSubAgentMultipartPacket({
          frame: packet.frame,
          sidecars: [{ descriptor, data: forgedBytes }],
        } as SubAgentTransportPeerPacket),
      ).toThrow();

      const nullPrototypeSidecars = [packet.sidecars[0]!];
      Object.setPrototypeOf(nullPrototypeSidecars, null);
      expect(() =>
        encodeHttpSubAgentMultipartPacket({
          frame: packet.frame,
          sidecars: nullPrototypeSidecars,
        }),
      ).toThrow();

      let iteratorCalls = 0;
      const hostileSidecars = [packet.sidecars[0]!] as Array<(typeof packet.sidecars)[number]> & {
        [Symbol.iterator](): ArrayIterator<(typeof packet.sidecars)[number]>;
      };
      Object.defineProperty(hostileSidecars, Symbol.iterator, {
        configurable: true,
        enumerable: false,
        value: () => {
          iteratorCalls += 1;
          return [packet.sidecars[0]!][Symbol.iterator]();
        },
      });
      expect(() =>
        encodeHttpSubAgentMultipartPacket({ frame: packet.frame, sidecars: hostileSidecars }),
      ).toThrow();
      expect(iteratorCalls).toBe(0);

      const tamperedBodies = [
        replaceBytes(encoded.body, 'Content-ID:', 'Content-Id:'),
        replaceBytes(encoded.body, '\r\n\r\n', '\n\n'),
        replaceBytes(encoded.body, 'OWNED-SIDECAR-PROOF', 'XWNED-SIDECAR-PROOF'),
      ];
      for (const [index, tampered] of tamperedBodies.entries()) {
        expectRejected({ ...encoded, body: tampered });

        const unsignedTamper = await probeAdmission({
          contentType: encoded.contentType,
          requestBody: tampered,
          signedBody: encoded.body,
          nonce: nonce(150 + index),
        });
        expect(unsignedTamper.result.status).toBe('rejected');
        expect(unsignedTamper.result.response.status).toBe(401);
        expect(unsignedTamper.counters).toEqual({ owner: 0, authorize: 0, onPacket: 0 });

        const trustedResign = await probeAdmission({
          contentType: encoded.contentType,
          requestBody: tampered,
          nonce: nonce(154 + index),
        });
        expect(trustedResign.result.status).toBe('rejected');
        expect(trustedResign.result.response.status).toBe(400);
        expect(trustedResign.counters).toEqual({ owner: 0, authorize: 0, onPacket: 0 });
      }
    },
  );

  acceptanceIt(
    'C7C-HTTP-MP05.l1.exact-route-policy',
    'raw-method-path-and-no-fallback',
    async () => {
      const routes = [
        ['/v1/heartbeat', { id: 'heartbeat', requestTarget: '/v1/heartbeat' }],
        ['/v1/jobs/create', { id: 'jobs.create', requestTarget: '/v1/jobs/create' }],
        [
          '/v1/jobs/job-1/resume',
          { id: 'jobs.resume', requestTarget: '/v1/jobs/job-1/resume', jobId: 'job-1' },
        ],
        [
          '/v1/jobs/job-1/reconnect',
          { id: 'jobs.reconnect', requestTarget: '/v1/jobs/job-1/reconnect', jobId: 'job-1' },
        ],
        [
          '/v1/jobs/job-1/cancel',
          { id: 'jobs.cancel', requestTarget: '/v1/jobs/job-1/cancel', jobId: 'job-1' },
        ],
        [
          '/v1/jobs/job-1/poll',
          { id: 'jobs.poll', requestTarget: '/v1/jobs/job-1/poll', jobId: 'job-1' },
        ],
        [
          '/v1/jobs/job-1/control/request-1/reply',
          {
            id: 'jobs.control-reply',
            requestTarget: '/v1/jobs/job-1/control/request-1/reply',
            jobId: 'job-1',
            requestId: 'request-1',
          },
        ],
      ] as const;
      for (const [requestTarget, expected] of routes) {
        const route = parseHttpSubAgentRoute('POST', requestTarget);
        expect(route).toEqual(expected);
        expect(Object.isFrozen(route)).toBe(true);
      }
      for (const jobId of ['a', 'a_b.c-d', 'a'.repeat(128)]) {
        expect(parseHttpSubAgentRoute('POST', `/v1/jobs/${jobId}/poll`)).toEqual({
          id: 'jobs.poll',
          requestTarget: `/v1/jobs/${jobId}/poll`,
          jobId,
        });
      }
      for (const requestId of ['a', 'a_b.c-d', 'a'.repeat(128)]) {
        expect(parseHttpSubAgentRoute('POST', `/v1/jobs/job-1/control/${requestId}/reply`)).toEqual(
          {
            id: 'jobs.control-reply',
            requestTarget: `/v1/jobs/job-1/control/${requestId}/reply`,
            jobId: 'job-1',
            requestId,
          },
        );
      }

      for (const method of ['GET', 'post', 'POST ', '', undefined]) {
        expect(() => parseHttpSubAgentRoute(method, '/v1/jobs/create')).toThrow();
      }

      for (const requestTarget of [
        '',
        'v1/jobs/create',
        '/v1/jobs',
        '/v1/jobs/create/',
        '/v1/jobs/create?',
        '/v1/jobs/create#fragment',
        '/v1/jobs/%63reate',
        '/v1\\jobs\\create',
        '/v1/./jobs/create',
        '/v1/jobs/../create',
        '/v1//jobs/create',
        '/v1/artifacts/upload',
        '/v1/artifacts/download',
        '/v1/jobs/job-1/artifacts',
        '/v1/jobs/_job/poll',
        '/v1/jobs/.job/poll',
        '/v1/jobs/-job/poll',
        '/v1/jobs/job~1/poll',
        `/v1/jobs/${'a'.repeat(129)}/poll`,
        '/v1/jobs/job-1/control//reply',
        '/v1/jobs/job-1/control/_request/reply',
        `/v1/jobs/job-1/control/${'a'.repeat(129)}/reply`,
        '/v1/jobs/job-1/control/request 1/reply',
        '/v1/jobs/job-1/poll\u0000',
        '/v1/jobs/任务/poll',
      ]) {
        expect(() => parseHttpSubAgentRoute('POST', requestTarget)).toThrow();
      }

      const heartbeatBody = bytes('signed-heartbeat-must-not-enter-packet-multipart');
      const heartbeatContentType = encodeHttpSubAgentMultipartPacket(createPacket()).contentType;
      const heartbeatHeaders = createHttpSubAgentHmacHeaders({
        method: 'POST',
        requestTarget: '/v1/heartbeat',
        body: heartbeatBody,
        keyId: HTTP_TEST_KEY_ID,
        key: HTTP_TEST_KEY,
        timestamp: HTTP_TEST_NOW,
        nonce: nonce(160),
      });
      const heartbeatRequest = {
        method: 'POST',
        requestTarget: '/v1/heartbeat',
        rawHeaders: [
          'Content-Type',
          heartbeatContentType,
          ...rawHeadersFromRecord(heartbeatHeaders),
        ],
        body: heartbeatBody,
        transport: {
          tls: false,
          loopback: true,
          requestTargetPreserved: true,
          redirectCount: 0,
        },
      } as const;
      const verifierClock = new ManualClock(HTTP_TEST_NOW);
      const verifier = createHttpSubAgentHmacVerifier({
        securityPolicy: { mode: 'loopback-test' },
        now: verifierClock.now,
        keyResolver: () => ({
          principalId: 'http-heartbeat-test-principal',
          key: HTTP_TEST_KEY,
        }),
        replayCache: new MemoryHttpSubAgentReplayCache({
          mode: 'loopback-test',
          now: verifierClock.now,
        }),
      });
      const authenticatedHeartbeat = await verifier.verify(heartbeatRequest);
      expect(authenticatedHeartbeat.route).toEqual({
        id: 'heartbeat',
        requestTarget: '/v1/heartbeat',
      });

      const heartbeatAdmission = await probeAdmission({
        contentType: heartbeatContentType,
        requestBody: heartbeatBody,
        requestTarget: '/v1/heartbeat',
        nonce: nonce(161),
      });
      expect(heartbeatAdmission.result.status).toBe('rejected');
      expect(heartbeatAdmission.result.response.status).toBe(400);
      expect(heartbeatAdmission.counters).toEqual({ owner: 0, authorize: 0, onPacket: 0 });
    },
  );
});
