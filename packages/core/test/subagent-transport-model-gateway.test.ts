import { describe, expect, it, vi } from 'vitest';

import { acceptanceIt, Deferred } from '../../../testkit';
import { createOpenAIChatProtocolSurface } from '../src/llm/chat';
import { createOpenAIResponsesProtocolSurface } from '../src/llm/responses';
import type { AgentProtocolCheckpointCodec } from '../src/subagent/checkpoint';
import { SubAgentRuntimeError } from '../src/subagent/errors';
import {
  canonicalJsonSha256,
  canonicalizeJson,
  parseJsonValue,
  type JsonValue,
} from '../src/subagent/json';
import {
  MemoryProviderOperationLedgerStore,
  ProviderOperationLedger,
  type ProviderOperationLedgerStore,
} from '../src/subagent/provider-operation-ledger';
import {
  setProviderOperationFailpointForTest,
  type ProviderOperationFailpointPhase,
} from '../src/subagent/provider-operation-ledger-internals';
import {
  createSubAgentTransportModelCanonicalRequest,
  createSubAgentTransportModelProxy,
  hashSubAgentTransportModelRequest,
  isSubAgentTransportModelProxy,
  SubAgentTransportModelGatewayHandler,
  SubAgentTransportModelGatewayRegistry,
  type SubAgentTransportModelGatewayHandleRequest,
  type SubAgentTransportModelGatewayOperation,
  type SubAgentTransportModelProtocolSurface,
} from '../src/subagent/transport-model-gateway';
import { markAuditedSubAgentTransportModelProtocolSurface } from '../src/subagent/transport-model-protocol-surface';
import type { SubAgentTransportRpcPayloadMap } from '../src/subagent/transport-rpc';
import { MockModel, response, type TestProtocol } from './helpers/mock-models';

type ModelRequestPayload = SubAgentTransportRpcPayloadMap['model.request'];

const CONTEXT = Object.freeze([{ kind: 'user' as const, content: 'hello' }]);
const TOOLS = Object.freeze([
  {
    name: 'proof',
    description: 'produce proof',
    parameters: { type: 'object', properties: {} },
  },
]);
const PROTOCOL_TOOLS = TOOLS as unknown as readonly TestProtocol['tool'][];
const CHECKPOINT_DIGEST = 'c'.repeat(64);

function protocolSurface(
  checkpointCodec: AgentProtocolCheckpointCodec<TestProtocol>,
): SubAgentTransportModelProtocolSurface<TestProtocol> {
  const surface: SubAgentTransportModelProtocolSurface<TestProtocol> = {
    checkpointCodec,
    buildUserMessage: (input) => ({
      kind: 'user',
      content: input.content.map((part) => part.text).join(''),
    }),
    buildSystemMessage: (input) => ({ kind: 'system', content: input.content }),
    buildToolCallOutputMessage: (input) => ({
      kind: 'tool',
      callId: input.callId,
      output: input.output,
    }),
    buildToolMessage: (input) => ({ ...input }),
    parseUserMessages: (context) =>
      context.flatMap((sourceMessage) =>
        sourceMessage.kind === 'user'
          ? [
              {
                message: {
                  content: [{ type: 'text' as const, text: sourceMessage.content }],
                },
                sourceMessage,
              },
            ]
          : [],
      ),
    parseSystemMessages: (context) =>
      context.flatMap((sourceMessage) =>
        sourceMessage.kind === 'system'
          ? [{ message: { content: sourceMessage.content }, sourceMessage }]
          : [],
      ),
    parseAssistantMessages: (context) =>
      context.flatMap((sourceMessage) =>
        sourceMessage.kind === 'assistant'
          ? [
              {
                message: {
                  content: [{ type: 'text' as const, text: sourceMessage.content }],
                },
                sourceMessage,
              },
            ]
          : [],
      ),
    parseToolCalls: (context) =>
      context.flatMap((sourceMessage) =>
        sourceMessage.kind === 'assistant'
          ? (sourceMessage.calls ?? []).map((sourceCall) => ({
              id: sourceCall.id,
              name: sourceCall.function.name,
              arguments: sourceCall.function.arguments,
              sourceMessage,
              sourceCall,
            }))
          : [],
      ),
    parseToolCallOutputMessages: (context) =>
      context.flatMap((sourceMessage) =>
        sourceMessage.kind === 'tool'
          ? [
              {
                message: { callId: sourceMessage.callId, output: sourceMessage.output },
                sourceMessage,
              },
            ]
          : [],
      ),
    rewriteToolPayloads: (context, replacements) => {
      if (replacements.inputs.length > 0 || replacements.results.length > 0) {
        throw new Error('The test protocol-only surface does not support payload rewriting.');
      }
      return [...context];
    },
    extractAssistantText: (context) =>
      context.flatMap((message) => (message.kind === 'assistant' ? [message.content] : [])),
    classifyError: (error) => ({
      kind: 'unknown',
      message: error instanceof Error ? error.message : String(error),
    }),
  };
  return markAuditedSubAgentTransportModelProtocolSurface(Object.freeze(surface));
}

function codec(protocol: string): AgentProtocolCheckpointCodec<TestProtocol> {
  return Object.freeze({
    protocol,
    version: '1',
    encode(context: readonly TestProtocol['context'][]): JsonValue {
      return parseJsonValue(canonicalizeJson(context as unknown as JsonValue));
    },
    decode(value: JsonValue): readonly TestProtocol['context'][] {
      if (!Array.isArray(value)) throw new TypeError('context must be an array');
      return parseJsonValue(
        canonicalizeJson(value),
      ) as unknown as readonly TestProtocol['context'][];
    },
  });
}

class GatewayModel extends MockModel {
  override readonly providerMaxRetries = 0;
  override readonly checkpointCodec: AgentProtocolCheckpointCodec<TestProtocol>;

  constructor(protocol: string) {
    super();
    this.checkpointCodec = codec(protocol);
  }
}

interface FixtureOptions {
  readonly protocol?: string;
  readonly acknowledgeCheckpoint?: (
    operation: Readonly<Omit<SubAgentTransportModelGatewayOperation, 'checkpointRevision'>>,
  ) => void | Promise<void>;
  readonly reserveBudget?: (
    operation: Readonly<SubAgentTransportModelGatewayOperation>,
  ) => void | Promise<void>;
  readonly failpoint?: (phase: ProviderOperationFailpointPhase) => void | Promise<void>;
  readonly now?: () => number;
  readonly watchTimeoutMs?: number;
}

function createFixture(options: FixtureOptions = {}) {
  const protocol = options.protocol ?? 'openai-chat';
  const model = new GatewayModel(protocol);
  const registry = new SubAgentTransportModelGatewayRegistry();
  registry.register({
    gatewayId: 'controller-model',
    protocol,
    codec: model.checkpointCodec,
    model,
  });
  registry.seal();
  const store = new MemoryProviderOperationLedgerStore();
  const ledger = new ProviderOperationLedger({ store });
  const order: string[] = [];
  if (options.failpoint !== undefined) {
    setProviderOperationFailpointForTest(ledger, async (phase) => {
      order.push(phase);
      await options.failpoint?.(phase);
    });
  }
  const acknowledged: Array<Omit<SubAgentTransportModelGatewayOperation, 'checkpointRevision'>> =
    [];
  const reserved: SubAgentTransportModelGatewayOperation[] = [];
  const handler = new SubAgentTransportModelGatewayHandler({
    registry,
    ledger,
    acknowledgeCheckpoint: async (operation) => {
      order.push('checkpoint');
      acknowledged.push(operation);
      await options.acknowledgeCheckpoint?.(operation);
      return {
        checkpointRevision: 11,
        checkpointDigest: operation.checkpointDigest,
      };
    },
    reserveBudget: async (operation) => {
      order.push('budget');
      reserved.push(operation);
      await options.reserveBudget?.(operation);
    },
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.watchTimeoutMs === undefined ? {} : { watchTimeoutMs: options.watchTimeoutMs }),
  });
  return { protocol, model, registry, store, ledger, handler, order, acknowledged, reserved };
}

function modelPayload(
  protocol = 'openai-chat',
  overrides: Partial<ModelRequestPayload> = {},
): ModelRequestPayload {
  const purpose = overrides.purpose ?? 'agent';
  const context = overrides.context ?? (CONTEXT as unknown as JsonValue);
  const tools = overrides.tools ?? (TOOLS as unknown as readonly JsonValue[]);
  const canonical = createSubAgentTransportModelCanonicalRequest({
    gatewayId: overrides.gatewayId ?? 'controller-model',
    protocol: overrides.protocol ?? protocol,
    codecVersion: overrides.codecVersion ?? '1',
    runId: overrides.runId ?? 'run-1',
    checkpointOperationId: overrides.checkpointOperationId ?? 'child-checkpoint-1',
    checkpointDigest: overrides.checkpointDigest ?? CHECKPOINT_DIGEST,
    purpose,
    iteration: overrides.iteration ?? 3,
    requestAttempt: overrides.requestAttempt ?? 2,
    context,
    tools,
  });
  return Object.freeze({
    providerOperationId: 'provider-operation-1',
    gatewayId: 'controller-model',
    protocol,
    codecVersion: '1',
    runId: 'run-1',
    executionAttempt: 1,
    executionEpoch: 'epoch-1',
    executionFencingToken: '7',
    checkpointOperationId: 'child-checkpoint-1',
    checkpointDigest: CHECKPOINT_DIGEST,
    purpose,
    iteration: 3,
    requestAttempt: 2,
    requestHash: canonicalJsonSha256(canonical as unknown as JsonValue),
    context,
    tools,
    ...overrides,
  });
}

function handleRequest(
  payload: ModelRequestPayload,
  overrides: Partial<SubAgentTransportModelGatewayHandleRequest> = {},
): SubAgentTransportModelGatewayHandleRequest {
  return {
    ownerSessionId: 'owner-session',
    taskId: 'task-1',
    operationId: payload.providerOperationId,
    payload,
    ...overrides,
  };
}

function ledgerRequestForPayload(payload: ModelRequestPayload): JsonValue {
  return createSubAgentTransportModelCanonicalRequest({
    gatewayId: payload.gatewayId,
    protocol: payload.protocol,
    codecVersion: payload.codecVersion,
    runId: payload.runId,
    checkpointOperationId: payload.checkpointOperationId,
    checkpointDigest: payload.checkpointDigest,
    purpose: payload.purpose,
    iteration: payload.iteration,
    requestAttempt: payload.requestAttempt,
    context: payload.context,
    tools: payload.tools,
  }) as unknown as JsonValue;
}

function providerStore(memory: MemoryProviderOperationLedgerStore): ProviderOperationLedgerStore {
  return {
    load: (identity, context) => memory.load(identity, context),
    create: (record, context) => memory.create(record, context),
    compareAndSet: (identity, revision, next, context) =>
      memory.compareAndSet(identity, revision, next, context),
    loadRequestAdmission: (identity, context) => memory.loadRequestAdmission(identity, context),
    createRequestAdmission: (record, context) => memory.createRequestAdmission(record, context),
    compareAndSetRequestAdmission: (identity, revision, next, context) =>
      memory.compareAndSetRequestAdmission(identity, revision, next, context),
  };
}

describe('Subagent transport Model gateway', () => {
  acceptanceIt(
    'C7-GATEWAY-17.l1.credential-free-surface',
    'official-credential-free-surface',
    () => {
      const chat = createOpenAIChatProtocolSurface();
      const responses = createOpenAIResponsesProtocolSurface();
      const exchange = vi.fn();

      expect(Object.isFrozen(chat)).toBe(true);
      expect(Object.isFrozen(responses)).toBe(true);
      expect(Object.getPrototypeOf(chat)).toBe(Object.prototype);
      expect(Object.getPrototypeOf(responses)).toBe(Object.prototype);
      expect('generate' in chat).toBe(false);
      expect('generate' in responses).toBe(false);
      expect(chat.checkpointCodec.protocol).toBe('openai-chat');
      expect(responses.checkpointCodec.protocol).toBe('openai-responses');
      expect(chat.buildUserMessage({ content: [{ type: 'text', text: 'hello' }] })).toEqual({
        role: 'user',
        content: [{ type: 'text', text: 'hello' }],
      });
      expect(responses.buildUserMessage({ content: [{ type: 'text', text: 'hello' }] })).toEqual({
        role: 'user',
        content: [{ type: 'input_text', text: 'hello' }],
      });

      expect(
        isSubAgentTransportModelProxy(
          createSubAgentTransportModelProxy({
            protocol: chat,
            gatewayId: 'chat-controller-model',
            exchange,
          }),
        ),
      ).toBe(true);
      expect(
        isSubAgentTransportModelProxy(
          createSubAgentTransportModelProxy({
            protocol: responses,
            gatewayId: 'responses-controller-model',
            exchange,
          }),
        ),
      ).toBe(true);

      const unbrandedStructuralCopy = Object.freeze({ ...chat });
      expect(() =>
        createSubAgentTransportModelProxy({
          protocol: unbrandedStructuralCopy,
          gatewayId: 'unbranded-controller-model',
          exchange,
        }),
      ).toThrow('Core-audited credential-free');

      const providerModel = new GatewayModel('openai-chat');
      expect(() =>
        createSubAgentTransportModelProxy({
          protocol: providerModel,
          gatewayId: 'provider-controller-model',
          exchange,
        }),
      ).toThrow('rejects provider-capable');
      expect(exchange).not.toHaveBeenCalled();
    },
  );

  it('rejects provider-capable protocol objects before any exchange', () => {
    const fixture = createFixture();
    const exchange = vi.fn();

    expect(() =>
      createSubAgentTransportModelProxy({
        protocol: fixture.model,
        gatewayId: 'controller-model',
        exchange,
      }),
    ).toThrow('rejects provider-capable');
    expect(exchange).not.toHaveBeenCalled();
  });

  it('requires the controller gateway registry to be sealed before handling traffic', () => {
    const registry = new SubAgentTransportModelGatewayRegistry();

    expect(
      () =>
        new SubAgentTransportModelGatewayHandler({
          registry,
          ledger: new ProviderOperationLedger({
            store: new MemoryProviderOperationLedgerStore(),
          }),
          acknowledgeCheckpoint: () => ({
            checkpointRevision: 1,
            checkpointDigest: CHECKPOINT_DIGEST,
          }),
          reserveBudget: () => undefined,
        }),
    ).toThrow('must be sealed');
  });

  it.each([undefined, 1])(
    'rejects a controller Model whose provider retry ceiling is %s',
    (providerMaxRetries) => {
      const model = new GatewayModel('openai-chat') as GatewayModel & {
        providerMaxRetries: number | undefined;
      };
      Object.defineProperty(model, 'providerMaxRetries', { value: providerMaxRetries });
      const registry = new SubAgentTransportModelGatewayRegistry();

      expect(() =>
        registry.register({
          gatewayId: 'unsafe-provider-retries',
          protocol: 'openai-chat',
          codec: model.checkpointCodec,
          model,
        }),
      ).toThrow('disable provider retries');
    },
  );

  acceptanceIt('C7-GATEWAY-05.l1.model-gateway', 'model-gateway', async () => {
    const fixture = createFixture();
    fixture.model.enqueue(() => {
      fixture.order.push('provider');
      return response({ kind: 'assistant', content: 'gateway-happy-path' });
    });

    const reply = await fixture.handler.handle(handleRequest(modelPayload()));

    expect(reply.ok).toBe(true);
    expect(fixture.order.slice(0, 3)).toEqual(['checkpoint', 'budget', 'provider']);
    expect(fixture.acknowledged).toHaveLength(1);
    expect(fixture.reserved).toHaveLength(1);
    expect(fixture.model.requests).toHaveLength(1);
    expect(fixture.store.snapshot()[0]?.phase).toBe('completed');
  });

  it.each(['openai-chat', 'openai-responses'])(
    'proxies %s builders and generation without transporting raw SDK data',
    async (protocol) => {
      const fixture = createFixture({ protocol });
      fixture.model.enqueue(() => {
        fixture.order.push('provider');
        return {
          ...response({ kind: 'assistant', content: 'done' }),
          usage: { inputTokens: 11, outputTokens: 3, totalTokens: 14 },
          raw: { fixture: 'raw-provider-secret' },
        };
      });
      const exchanged: ModelRequestPayload[] = [];
      const proxy = createSubAgentTransportModelProxy({
        protocol: protocolSurface(fixture.model.checkpointCodec),
        gatewayId: 'controller-model',
        exchange: async (request) => {
          exchanged.push(request.payload);
          return fixture.handler.handle(
            handleRequest(request.payload, {
              taskId: request.taskId,
              operationId: request.operationId,
              ...(request.signal === undefined ? {} : { signal: request.signal }),
            }),
          );
        },
      });

      expect(isSubAgentTransportModelProxy(proxy)).toBe(true);
      expect(isSubAgentTransportModelProxy(fixture.model)).toBe(false);
      expect(proxy.checkpointCodec).toBe(fixture.model.checkpointCodec);
      expect(proxy.buildSystemMessage({ content: 'system' })).toEqual({
        kind: 'system',
        content: 'system',
      });

      const result = await proxy.generate({
        context: CONTEXT,
        tools: PROTOCOL_TOOLS,
        runtime: {
          sessionId: 'owner-session',
          runId: 'run-1',
          taskId: 'task-1',
          executionAttempt: 1,
          executionEpoch: 'epoch-1',
          executionFencingToken: '7',
          providerOperationId: 'provider-operation-1',
          checkpointOperationId: 'child-checkpoint-1',
          checkpointDigest: CHECKPOINT_DIGEST,
          iteration: 3,
          requestAttempt: 2,
        },
      });

      expect(result).toEqual({
        messages: [{ kind: 'assistant', content: 'done' }],
        usage: { inputTokens: 11, outputTokens: 3, totalTokens: 14 },
        raw: undefined,
      });
      expect(Object.isFrozen(result.usage)).toBe(true);
      expect(JSON.stringify(result)).not.toContain('raw-provider-secret');
      expect(exchanged).toHaveLength(1);
      expect(exchanged[0]).toMatchObject({
        protocol,
        purpose: 'agent',
        iteration: 3,
        requestAttempt: 2,
      });
      expect(exchanged[0]?.requestHash).toBe(
        hashSubAgentTransportModelRequest({
          gatewayId: 'controller-model',
          protocol,
          codecVersion: '1',
          runId: 'run-1',
          checkpointOperationId: 'child-checkpoint-1',
          checkpointDigest: CHECKPOINT_DIGEST,
          purpose: 'agent',
          iteration: 3,
          requestAttempt: 2,
          context: CONTEXT as unknown as JsonValue,
          tools: TOOLS as unknown as readonly JsonValue[],
        }),
      );
      expect(fixture.order.slice(0, 3)).toEqual(['checkpoint', 'budget', 'provider']);
      expect(fixture.reserved[0]).toMatchObject(fixture.acknowledged[0]!);
      expect(fixture.reserved[0]?.checkpointRevision).toBe(11);
      expect(fixture.model.requests[0]?.runtime).toEqual({
        sessionId: 'owner-session',
        runId: 'run-1',
        taskId: 'task-1',
        executionAttempt: 1,
        executionEpoch: 'epoch-1',
        executionFencingToken: '7',
        providerOperationId: 'provider-operation-1',
        checkpointOperationId: 'child-checkpoint-1',
        checkpointDigest: CHECKPOINT_DIGEST,
        iteration: 3,
        requestAttempt: 2,
      });
      expect(fixture.model.requests[0]).not.toHaveProperty('gatewayId');
    },
  );

  it('replays a completed operation without a second SDK call', async () => {
    const fixture = createFixture();
    fixture.model.enqueue(response({ kind: 'assistant', content: 'once' }));
    const payload = modelPayload();

    const first = await fixture.handler.handle(handleRequest(payload));
    const second = await fixture.handler.handle(handleRequest(payload));

    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    expect(fixture.model.requests).toHaveLength(1);
    expect(fixture.acknowledged).toHaveLength(2);
    expect(fixture.reserved).toHaveLength(1);
  });

  it('joins a live duplicate operation instead of reporting a contradictory unknown outcome', async () => {
    let releaseProvider!: () => void;
    let markStarted!: () => void;
    const providerStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const providerRelease = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const fixture = createFixture();
    fixture.model.enqueue(async () => {
      markStarted();
      await providerRelease;
      return response({ kind: 'assistant', content: 'single-flight' });
    });
    const payload = modelPayload();

    const first = fixture.handler.handle(handleRequest(payload));
    await providerStarted;
    const second = fixture.handler.handle(handleRequest(payload));
    releaseProvider();
    const [firstReply, secondReply] = await Promise.all([first, second]);

    expect(firstReply).toEqual(secondReply);
    expect(firstReply.ok).toBe(true);
    expect(fixture.model.requests).toHaveLength(1);
    expect(fixture.acknowledged).toHaveLength(1);
    expect(fixture.reserved).toHaveLength(1);
    expect(fixture.store.snapshot()[0]?.phase).toBe('completed');
  });

  it('installs local single-flight before a synchronously re-entrant checkpoint ACK', async () => {
    const payload = modelPayload();
    const holder: { handler?: SubAgentTransportModelGatewayHandler } = {};
    let reentered: Promise<SubAgentTransportRpcPayloadMap['model.reply']> | undefined;
    const fixture = createFixture({
      acknowledgeCheckpoint: () => {
        if (holder.handler === undefined) throw new Error('Gateway handler is not ready.');
        reentered ??= holder.handler.handle(handleRequest(payload));
      },
    });
    holder.handler = fixture.handler;
    fixture.model.enqueue(response({ kind: 'assistant', content: 'ack-reentry' }));

    const first = await fixture.handler.handle(handleRequest(payload));
    const duplicate = await reentered;

    expect(first).toEqual(duplicate);
    expect(fixture.acknowledged).toHaveLength(1);
    expect(fixture.reserved).toHaveLength(1);
    expect(fixture.model.requests).toHaveLength(1);
  });

  acceptanceIt(
    'C7-GATEWAY-12.l1.cross-handler-singleflight',
    'cross-handler-singleflight',
    async () => {
      const providerStarted = new Deferred<void>();
      const providerRelease = new Deferred<void>();
      const fixture = createFixture();
      const siblingLedger = new ProviderOperationLedger({ store: fixture.store });
      const sibling = new SubAgentTransportModelGatewayHandler({
        registry: fixture.registry,
        ledger: siblingLedger,
        acknowledgeCheckpoint: async (operation) => {
          fixture.order.push('checkpoint');
          fixture.acknowledged.push(operation);
          return {
            checkpointRevision: 11,
            checkpointDigest: operation.checkpointDigest,
          };
        },
        reserveBudget: async (operation) => {
          fixture.order.push('budget');
          fixture.reserved.push(operation);
        },
      });
      fixture.model.enqueue(async () => {
        providerStarted.resolve(undefined);
        await providerRelease.promise;
        return response({ kind: 'assistant', content: 'shared-admission' });
      });
      const payload = modelPayload();

      const first = fixture.handler.handle(handleRequest(payload));
      const second = sibling.handle(handleRequest(payload));
      await providerStarted.promise;
      providerRelease.resolve(undefined);
      const replies = await Promise.all([first, second]);

      expect(replies[0]).toEqual(replies[1]);
      expect(fixture.acknowledged).toHaveLength(2);
      expect(fixture.reserved).toHaveLength(1);
      expect(fixture.model.requests).toHaveLength(1);
      expect(fixture.store.requestAdmissionSnapshot()).toMatchObject([
        { phase: 'budget_reserved', revision: 1 },
      ]);
    },
  );

  it('requires explicit host recovery for an admitted crash and never lets normal replay steal it', async () => {
    const firstBudgetStarted = new Deferred<void>();
    const strandedBudget = new Promise<void>(() => undefined);
    let budgetCalls = 0;
    const fixture = createFixture({
      reserveBudget: () => {
        budgetCalls += 1;
        if (budgetCalls === 1) {
          firstBudgetStarted.resolve(undefined);
          return strandedBudget;
        }
      },
    });
    const payload = modelPayload();
    const originalAbort = new AbortController();
    const original = fixture.handler.handle(
      handleRequest(payload, { signal: originalAbort.signal }),
    );
    await firstBudgetStarted.promise;
    originalAbort.abort();
    await expect(original).resolves.toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
    expect(fixture.store.requestAdmissionSnapshot()).toMatchObject([
      { phase: 'admitted', revision: 0 },
    ]);

    const observerAbort = new AbortController();
    const observer = fixture.handler.handle(
      handleRequest(payload, { signal: observerAbort.signal }),
    );
    await vi.waitFor(() => expect(fixture.acknowledged).toHaveLength(2));
    expect(fixture.reserved).toHaveLength(1);
    observerAbort.abort();
    await expect(observer).resolves.toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
    expect(fixture.reserved).toHaveLength(1);
    expect(fixture.model.requests).toHaveLength(0);

    fixture.model.enqueue(response({ kind: 'assistant', content: 'recovered-admission' }));
    const recovered = await fixture.handler.recoverRequestAdmission(handleRequest(payload));

    expect(recovered.ok).toBe(true);
    expect(fixture.reserved).toHaveLength(2);
    expect(fixture.reserved[1]).toEqual(fixture.reserved[0]);
    expect(fixture.model.requests).toHaveLength(1);
    expect(fixture.store.requestAdmissionSnapshot()).toMatchObject([
      { phase: 'budget_reserved', revision: 2 },
    ]);
  });

  it('rejects a conflicting request in a second handler before budget reservation', async () => {
    const budgetEntered = new Deferred<void>();
    const budgetRelease = new Deferred<void>();
    const fixture = createFixture({
      reserveBudget: async () => {
        budgetEntered.resolve(undefined);
        await budgetRelease.promise;
      },
    });
    const siblingBudget = vi.fn();
    const sibling = new SubAgentTransportModelGatewayHandler({
      registry: fixture.registry,
      ledger: new ProviderOperationLedger({ store: fixture.store }),
      acknowledgeCheckpoint: (operation) => ({
        checkpointRevision: 12,
        checkpointDigest: operation.checkpointDigest,
      }),
      reserveBudget: siblingBudget,
    });
    fixture.model.enqueue(response({ kind: 'assistant', content: 'authoritative' }));
    const firstPayload = modelPayload();
    const conflictingPayload = modelPayload('openai-chat', {
      context: [{ kind: 'user', content: 'conflicting' }],
    });

    const first = fixture.handler.handle(handleRequest(firstPayload));
    await budgetEntered.promise;
    const conflict = await sibling.handle(handleRequest(conflictingPayload));
    budgetRelease.resolve(undefined);
    const firstReply = await first;

    expect(firstReply.ok).toBe(true);
    expect(conflict).toMatchObject({
      ok: false,
      error: { code: 'IDEMPOTENCY_CONFLICT' },
    });
    expect(fixture.reserved).toHaveLength(1);
    expect(siblingBudget).not.toHaveBeenCalled();
    expect(fixture.model.requests).toHaveLength(1);
  });

  it('persists and replays only the closed safe budget rejection', async () => {
    const secret = 'budget-callback-secret';
    const fixture = createFixture({
      reserveBudget: () => {
        throw Object.assign(new Error(secret), { rawBody: secret });
      },
    });
    const payload = modelPayload();

    const first = await fixture.handler.handle(handleRequest(payload));
    const replay = await fixture.handler.handle(handleRequest(payload));

    expect(first).toEqual(replay);
    expect(first).toMatchObject({
      ok: false,
      error: {
        code: 'INTERNAL_ERROR',
        causeCode: 'MODEL_GATEWAY_FAILED',
      },
    });
    expect(fixture.reserved).toHaveLength(1);
    expect(fixture.model.requests).toHaveLength(0);
    expect(fixture.store.snapshot()).toHaveLength(0);
    expect(fixture.store.requestAdmissionSnapshot()).toMatchObject([
      {
        phase: 'budget_rejected',
        failure: { code: 'INTERNAL_ERROR', causeCode: 'MODEL_GATEWAY_FAILED' },
      },
    ]);
    expect(JSON.stringify(fixture.store.requestAdmissionSnapshot())).not.toContain(secret);
  });

  it('re-envelopes one live provider result for a legally advanced execution scope', async () => {
    let releaseProvider!: () => void;
    let markStarted!: () => void;
    const providerStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const providerRelease = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const fixture = createFixture();
    fixture.model.enqueue(async () => {
      markStarted();
      await providerRelease;
      return response({ kind: 'assistant', content: 'advanced-scope' });
    });
    const firstPayload = modelPayload();
    const recoveredPayload = modelPayload('openai-chat', {
      executionAttempt: 2,
      executionEpoch: 'epoch-2',
      executionFencingToken: '8',
    });
    expect(recoveredPayload.requestHash).toBe(firstPayload.requestHash);

    const first = fixture.handler.handle(handleRequest(firstPayload));
    await providerStarted;
    const recovered = fixture.handler.handle(handleRequest(recoveredPayload));
    releaseProvider();
    const [firstReply, recoveredReply] = await Promise.all([first, recovered]);

    expect(firstReply).toMatchObject({
      ok: true,
      executionAttempt: 1,
      executionEpoch: 'epoch-1',
      executionFencingToken: '7',
    });
    expect(recoveredReply).toMatchObject({
      ok: true,
      executionAttempt: 2,
      executionEpoch: 'epoch-2',
      executionFencingToken: '8',
    });
    expect(fixture.model.requests).toHaveLength(1);
    expect(fixture.acknowledged).toHaveLength(2);
    expect(fixture.reserved).toHaveLength(1);
    expect(fixture.store.snapshot()[0]?.reply).toEqual({
      version: '1',
      ok: true,
      resultHash: canonicalJsonSha256([{ kind: 'assistant', content: 'advanced-scope' }]),
      messages: [{ kind: 'assistant', content: 'advanced-scope' }],
    });
  });

  it('rejects a reused operation ID with a different canonical hash', async () => {
    const fixture = createFixture();
    fixture.model.enqueue(response({ kind: 'assistant', content: 'first' }));
    const first = modelPayload();
    expect((await fixture.handler.handle(handleRequest(first))).ok).toBe(true);
    const second = modelPayload('openai-chat', {
      context: [{ kind: 'user', content: 'different' }],
    });

    const reply = await fixture.handler.handle(handleRequest(second));

    expect(reply).toMatchObject({
      ok: false,
      error: { code: 'IDEMPOTENCY_CONFLICT', retryable: false },
    });
    expect(fixture.model.requests).toHaveLength(1);
  });

  it('rejects a bad canonical hash before checkpoint or budget callbacks', async () => {
    const fixture = createFixture();
    const payload = modelPayload('openai-chat', { requestHash: '0'.repeat(64) });

    const reply = await fixture.handler.handle(handleRequest(payload));

    expect(reply).toMatchObject({ ok: false, error: { code: 'IDEMPOTENCY_CONFLICT' } });
    expect(fixture.acknowledged).toHaveLength(0);
    expect(fixture.reserved).toHaveLength(0);
    expect(fixture.model.requests).toHaveLength(0);
  });

  it('uses the checkpoint acknowledgement as the non-enumerating scope oracle', async () => {
    const fixture = createFixture({
      acknowledgeCheckpoint: (operation) => {
        if (operation.ownerSessionId !== 'owner-session') {
          throw new SubAgentRuntimeError({
            code: 'RESOURCE_NOT_FOUND',
            message: 'secret task exists in another session',
            retryable: false,
          });
        }
      },
    });
    const reply = await fixture.handler.handle(
      handleRequest(modelPayload(), { ownerSessionId: 'other-session' }),
    );

    expect(reply).toMatchObject({
      ok: false,
      error: {
        code: 'RESOURCE_NOT_FOUND',
        message: 'The requested resource was not found.',
      },
    });
    expect(JSON.stringify(reply)).not.toContain('secret task');
    expect(fixture.reserved).toHaveLength(0);
    expect(fixture.model.requests).toHaveLength(0);
    expect(fixture.store.snapshot()).toHaveLength(0);
  });

  it.each([
    ['after_prepare_before_in_flight', 0, false],
    ['after_in_flight_before_provider', 0, true],
    ['after_provider_before_complete', 1, true],
    ['after_complete', 1, false],
  ] as const)(
    'enforces the %s crash oracle',
    async (targetPhase, expectedSdkCalls, outcomeUnknown) => {
      let injected = false;
      const fixture = createFixture({
        failpoint: (phase) => {
          if (!injected && phase === targetPhase) {
            injected = true;
            throw new Error(`crash:${phase}`);
          }
        },
      });
      fixture.model.enqueue(response({ kind: 'assistant', content: 'completed' }));
      const payload = modelPayload();

      const first = await fixture.handler.handle(handleRequest(payload));
      expect(fixture.model.requests).toHaveLength(expectedSdkCalls);
      const needsHostRecovery =
        targetPhase === 'after_in_flight_before_provider' ||
        targetPhase === 'after_provider_before_complete';
      const replayPromise = fixture.handler.handle(handleRequest(payload));
      if (needsHostRecovery) {
        await vi.waitFor(() => {
          expect(fixture.store.snapshot()[0]?.phase).toBe('in_flight');
        });
        const recovered = await fixture.ledger.recoverInFlight({
          ownerSessionId: 'owner-session',
          taskId: 'task-1',
          providerOperationId: payload.providerOperationId,
        });
        expect(recovered.status).toBe('outcome_unknown');
      }
      const replay = await replayPromise;

      if (targetPhase === 'after_prepare_before_in_flight') {
        expect(first).toMatchObject({ ok: false });
        if (!first.ok) expect(first.error).not.toHaveProperty('outcomeUnknown');
        expect(replay.ok).toBe(true);
        expect(fixture.model.requests).toHaveLength(1);
      } else if (targetPhase === 'after_complete') {
        expect(fixture.model.requests).toHaveLength(1);
        expect(first.ok).toBe(true);
        expect(replay).toEqual(first);
      } else {
        expect(fixture.model.requests).toHaveLength(expectedSdkCalls);
        expect(first).toMatchObject({ ok: false, error: { outcomeUnknown } });
        expect(replay).toEqual(first);
        expect(fixture.store.snapshot()[0]?.phase).toBe('outcome_unknown');
      }
    },
  );

  it('clears local pending state when a hanging Store is aborted or reaches its deadline', async () => {
    const fixture = createFixture();
    const memory = new MemoryProviderOperationLedgerStore();
    const never = new Promise<never>(() => undefined);
    const contexts: Array<Readonly<{ signal?: AbortSignal; deadlineAt?: number }> | undefined> = [];
    let hang = true;
    const store: ProviderOperationLedgerStore = {
      ...providerStore(memory),
      loadRequestAdmission: (identity, context) => {
        contexts.push(context);
        return hang ? never : memory.loadRequestAdmission(identity, context);
      },
    };
    const handler = new SubAgentTransportModelGatewayHandler({
      registry: fixture.registry,
      ledger: new ProviderOperationLedger({ store }),
      acknowledgeCheckpoint: (operation) => ({
        checkpointRevision: 11,
        checkpointDigest: operation.checkpointDigest,
      }),
      reserveBudget: () => undefined,
    });

    const abortPayload = modelPayload();
    const controller = new AbortController();
    const aborted = handler.handle(handleRequest(abortPayload, { signal: controller.signal }));
    await vi.waitFor(() => expect(contexts).toHaveLength(1));
    controller.abort();
    await expect(aborted).resolves.toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
    expect(contexts[0]?.signal?.aborted).toBe(true);

    hang = false;
    fixture.model.enqueue(response({ kind: 'assistant', content: 'after-abort' }));
    await expect(handler.handle(handleRequest(abortPayload))).resolves.toMatchObject({ ok: true });

    hang = true;
    const deadlinePayload = modelPayload('openai-chat', {
      providerOperationId: 'provider-operation-deadline',
    });
    const deadlineAt = Date.now() + 20;
    const timedOut = await handler.handle(handleRequest(deadlinePayload, { deadlineAt }));
    expect(timedOut).toMatchObject({ ok: false, error: { code: 'TIMED_OUT' } });
    expect(contexts.at(-1)?.deadlineAt).toBe(deadlineAt);
    expect(contexts.at(-1)?.signal?.aborted).toBe(true);

    hang = false;
    fixture.model.enqueue(response({ kind: 'assistant', content: 'after-deadline' }));
    await expect(handler.handle(handleRequest(deadlinePayload))).resolves.toMatchObject({
      ok: true,
    });
    expect(fixture.model.requests).toHaveLength(2);
  });

  it('polls admitted observers with bounded exponential backoff', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    try {
      const fixture = createFixture();
      const memory = new MemoryProviderOperationLedgerStore();
      const seed = new ProviderOperationLedger({ store: memory });
      const payload = modelPayload();
      await seed.admitRequest(
        {
          ownerSessionId: 'owner-session',
          taskId: 'task-1',
          providerOperationId: payload.providerOperationId,
        },
        ledgerRequestForPayload(payload),
      );
      const loadTimes: number[] = [];
      const store: ProviderOperationLedgerStore = {
        ...providerStore(memory),
        loadRequestAdmission: (identity, context) => {
          loadTimes.push(Date.now());
          return memory.loadRequestAdmission(identity, context);
        },
      };
      const reserveBudget = vi.fn();
      const handler = new SubAgentTransportModelGatewayHandler({
        registry: fixture.registry,
        ledger: new ProviderOperationLedger({ store }),
        acknowledgeCheckpoint: (operation) => ({
          checkpointRevision: 11,
          checkpointDigest: operation.checkpointDigest,
        }),
        reserveBudget,
        watchTimeoutMs: 75,
      });

      const observer = handler.handle(handleRequest(payload));
      await vi.advanceTimersByTimeAsync(75);
      await expect(observer).resolves.toMatchObject({ ok: false, error: { code: 'TIMED_OUT' } });

      expect(loadTimes).toEqual([
        Date.parse('2026-01-01T00:00:00.000Z'),
        Date.parse('2026-01-01T00:00:00.010Z'),
        Date.parse('2026-01-01T00:00:00.030Z'),
        Date.parse('2026-01-01T00:00:00.070Z'),
      ]);
      expect(reserveBudget).not.toHaveBeenCalled();
      expect(fixture.model.requests).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds an in-flight observer without changing authoritative state', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    try {
      let injected = false;
      const fixture = createFixture({
        watchTimeoutMs: 5,
        failpoint: (phase) => {
          if (!injected && phase === 'after_in_flight_before_provider') {
            injected = true;
            throw new Error('controller-crash');
          }
        },
      });
      const payload = modelPayload();

      const first = await fixture.handler.handle(handleRequest(payload));
      const observer = fixture.handler.handle(handleRequest(payload));
      await vi.advanceTimersByTimeAsync(5);

      expect(first).toMatchObject({ ok: false, error: { outcomeUnknown: true } });
      await expect(observer).resolves.toMatchObject({ ok: false, error: { code: 'TIMED_OUT' } });
      expect(fixture.store.snapshot()[0]?.phase).toBe('in_flight');
      expect(fixture.model.requests).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('classifies provider failure without exposing Error, provider body, metadata or raw response', async () => {
    const fixture = createFixture();
    const secret = 'sk-secret-provider-body';
    fixture.model.enqueue(new Error(secret));
    fixture.model.classifyError = vi.fn(() => ({
      kind: 'context_length_exceeded',
      message: secret,
      provider: secret,
      requestId: secret,
      metadata: { rawBody: secret },
    }));
    const reply = await fixture.handler.handle(handleRequest(modelPayload()));

    expect(reply).toMatchObject({
      ok: false,
      error: {
        code: 'EXECUTOR_FAILED',
        causeCode: 'MODEL_CONTEXT_LENGTH_EXCEEDED_OUTCOME_UNKNOWN',
        outcomeUnknown: true,
      },
    });
    expect(JSON.stringify(reply)).not.toContain(secret);
    expect(fixture.model.classifyError).toHaveBeenCalledOnce();
    expect(fixture.model.requests).toHaveLength(1);
  });

  it('rejects unsafe provider usage without persisting or returning the invalid counters', async () => {
    const fixture = createFixture();
    fixture.model.enqueue({
      ...response({ kind: 'assistant', content: 'invalid-usage' }),
      usage: { inputTokens: -1 },
    });

    const reply = await fixture.handler.handle(handleRequest(modelPayload()));

    expect(reply).toMatchObject({
      ok: false,
      error: { code: 'EXECUTOR_FAILED', outcomeUnknown: true },
    });
    expect(reply).not.toHaveProperty('usage');
    expect(fixture.store.snapshot()).toMatchObject([{ phase: 'outcome_unknown' }]);
    expect(fixture.store.snapshot()[0]).not.toHaveProperty('reply');
    expect(fixture.model.requests).toHaveLength(1);
  });

  it('persists a confirmed HTTP context rejection and restores its safe classification', async () => {
    const fixture = createFixture();
    const secret = 'provider-error-body-secret';
    fixture.model.enqueue(new Error(secret));
    fixture.model.classifyError = vi.fn(() => ({
      kind: 'context_length_exceeded',
      message: secret,
      status: 400,
      providerCode: secret,
      metadata: { rawBody: secret },
    }));
    const proxy = createSubAgentTransportModelProxy({
      protocol: protocolSurface(fixture.model.checkpointCodec),
      gatewayId: 'controller-model',
      exchange: (request) =>
        fixture.handler.handle(
          handleRequest(request.payload, {
            taskId: request.taskId,
            operationId: request.operationId,
          }),
        ),
    });
    const request = {
      context: CONTEXT,
      tools: PROTOCOL_TOOLS,
      runtime: {
        runId: 'run-1',
        taskId: 'task-1',
        executionAttempt: 1,
        executionEpoch: 'epoch-1',
        executionFencingToken: '7',
        providerOperationId: 'provider-operation-1',
        checkpointOperationId: 'child-checkpoint-1',
        checkpointDigest: CHECKPOINT_DIGEST,
        iteration: 3,
        requestAttempt: 2,
      },
    } as const;

    const failure = await proxy.generate(request).catch((error: unknown) => error);
    expect(proxy.classifyError(failure, { purpose: 'agent', request })).toMatchObject({
      kind: 'context_length_exceeded',
      status: 400,
    });
    const replay = await fixture.handler.handle(handleRequest(modelPayload()));

    expect(replay).toMatchObject({
      ok: false,
      error: {
        code: 'INTERNAL_ERROR',
        causeCode: 'MODEL_CONTEXT_LENGTH_EXCEEDED',
      },
      classification: { kind: 'context_length_exceeded', status: 400 },
    });
    expect(JSON.stringify(replay)).not.toContain(secret);
    expect(fixture.model.requests).toHaveLength(1);
    expect(fixture.reserved).toHaveLength(1);
    expect(fixture.store.snapshot()[0]?.phase).toBe('completed');
  });

  it('rejects proxy calls missing host-only runtime identity before exchange', async () => {
    const fixture = createFixture();
    const exchange = vi.fn();
    const proxy = createSubAgentTransportModelProxy({
      protocol: protocolSurface(fixture.model.checkpointCodec),
      gatewayId: 'controller-model',
      exchange,
    });

    await expect(proxy.generate({ context: CONTEXT, tools: PROTOCOL_TOOLS })).rejects.toThrow(
      'runtime.taskId',
    );
    expect(exchange).not.toHaveBeenCalled();
  });

  it('honors target abort and expired deadline before exchange', async () => {
    const fixture = createFixture();
    const exchange = vi.fn();
    const proxy = createSubAgentTransportModelProxy({
      protocol: protocolSurface(fixture.model.checkpointCodec),
      gatewayId: 'controller-model',
      exchange,
      now: () => 1_000,
    });
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    const runtime = {
      runId: 'run-1',
      taskId: 'task-1',
      executionAttempt: 1,
      executionEpoch: 'epoch-1',
      executionFencingToken: '7',
      providerOperationId: 'provider-operation-1',
      checkpointOperationId: 'child-checkpoint-1',
      checkpointDigest: CHECKPOINT_DIGEST,
      iteration: 0,
      requestAttempt: 1,
    };

    await expect(
      proxy.generate({
        context: CONTEXT,
        tools: PROTOCOL_TOOLS,
        runtime,
        signal: controller.signal,
      }),
    ).rejects.toThrow('stop');
    await expect(
      proxy.generate({ context: CONTEXT, tools: PROTOCOL_TOOLS, runtime, deadlineAt: 1_000 }),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(exchange).not.toHaveBeenCalled();
  });

  it('rejects an already-expired controller request before callbacks and provider access', async () => {
    const fixture = createFixture();
    const reply = await fixture.handler.handle(
      handleRequest(modelPayload('openai-chat', { remainingMs: 0 })),
    );

    expect(reply).toMatchObject({ ok: false, error: { code: 'TIMED_OUT' } });
    expect(fixture.acknowledged).toHaveLength(0);
    expect(fixture.reserved).toHaveLength(0);
    expect(fixture.model.requests).toHaveLength(0);
  });

  it('lets the trusted host deadline cap a target-provided oversized remainingMs', async () => {
    const fixture = createFixture();
    const reply = await fixture.handler.handle(
      handleRequest(modelPayload('openai-chat', { remainingMs: 60_000 }), {
        deadlineAt: Date.now() - 1,
      }),
    );

    expect(reply).toMatchObject({ ok: false, error: { code: 'TIMED_OUT' } });
    expect(fixture.acknowledged).toHaveLength(0);
    expect(fixture.reserved).toHaveLength(0);
    expect(fixture.model.requests).toHaveLength(0);
  });

  it('validates exact reply identity and result hash before codec decode', async () => {
    const fixture = createFixture();
    const base = modelPayload();
    const proxy = createSubAgentTransportModelProxy({
      protocol: protocolSurface(fixture.model.checkpointCodec),
      gatewayId: 'controller-model',
      exchange: async () => ({
        providerOperationId: base.providerOperationId,
        gatewayId: base.gatewayId,
        protocol: base.protocol,
        codecVersion: base.codecVersion,
        runId: base.runId,
        executionAttempt: base.executionAttempt,
        executionEpoch: base.executionEpoch,
        executionFencingToken: base.executionFencingToken,
        checkpointOperationId: base.checkpointOperationId,
        checkpointDigest: base.checkpointDigest,
        requestHash: base.requestHash,
        ok: true,
        resultHash: '0'.repeat(64),
        messages: [{ kind: 'assistant', content: 'tampered' }],
      }),
    });

    await expect(
      proxy.generate({
        context: CONTEXT,
        tools: PROTOCOL_TOOLS,
        runtime: {
          runId: 'run-1',
          taskId: 'task-1',
          executionAttempt: 1,
          executionEpoch: 'epoch-1',
          executionFencingToken: '7',
          providerOperationId: 'provider-operation-1',
          checkpointOperationId: 'child-checkpoint-1',
          checkpointDigest: CHECKPOINT_DIGEST,
          iteration: 3,
          requestAttempt: 2,
        },
      }),
    ).rejects.toThrow('result hash');
  });
});
