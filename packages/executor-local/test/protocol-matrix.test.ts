import { describe, expect, vi } from 'vitest';
import { z } from 'zod';

import {
  Agent,
  canonicalJsonSha256,
  createSubAgentRuntime,
  defineSubAgent,
  type AgentProtocol,
  type JsonValue,
  type Model,
  OpenAIChatModel,
  type OpenAIChatProtocol,
  OpenAIResponsesModel,
  type OpenAIResponsesProtocol,
  type ToolRuntimeDefinition,
} from '@ruixutong.manee/maneeagent-framework';

import { acceptanceIt, RecordingRuntimeStateStore } from '../../../testkit';
import {
  createLocalAgentRunnerRegistration,
  LocalSubAgentRunnerRegistry,
  MemorySubAgentExecutor,
} from '../src';

type ProtocolKind = 'chat' | 'responses';
type Lane = 'slow' | 'fast';

const inputSchema = z
  .object({
    lane: z.enum(['slow', 'fast']),
    sequence: z.number().int(),
    payload: z.object({ marker: z.string() }).strict(),
  })
  .strict();
const outputSchema = z
  .object({
    lane: z.enum(['slow', 'fast']),
    sequence: z.number().int(),
    proof: z.string(),
  })
  .strict();
type ProtocolInput = z.infer<typeof inputSchema>;
type ProtocolOutput = z.infer<typeof outputSchema>;

const definition = defineSubAgent({
  name: 'protocol-proof',
  version: '2',
  description: 'Return a typed protocol-isolation proof.',
  inputSchema,
  outputSchema,
});

const fixtures = Object.freeze([
  Object.freeze({
    lane: 'slow' as const,
    sequence: 1,
    payload: Object.freeze({ marker: 'input-slow' }),
  }),
  Object.freeze({
    lane: 'fast' as const,
    sequence: 2,
    payload: Object.freeze({ marker: 'input-fast' }),
  }),
]);

interface ProviderToolCall {
  readonly callId: string;
  readonly name: string;
  readonly input: JsonValue;
}

interface ProviderToolOutput {
  readonly callId: string;
  readonly output: string;
}

interface FakeSdkCall {
  readonly payload: unknown;
  readonly options: unknown;
  readonly signalAbortedAtCall: boolean;
}

type FakeSdkResponder = (round: number, payload: unknown) => unknown | Promise<unknown>;

interface AdapterHarness<P extends AgentProtocol> {
  readonly model: Model<P>;
  readonly calls: FakeSdkCall[];
}

interface ProtocolSpec<P extends AgentProtocol> {
  readonly kind: ProtocolKind;
  readonly checkpointProtocol: string;
  createModel(responder: FakeSdkResponder): AdapterHarness<P>;
  toolResponse(calls: readonly ProviderToolCall[]): unknown;
  extractToolOutputs(payload: unknown): readonly ProviderToolOutput[];
  toolDefinition(payload: unknown, name: string): Record<string, unknown> | undefined;
  assertWire(payload: unknown): void;
}

const chatSpec: ProtocolSpec<OpenAIChatProtocol> = {
  kind: 'chat',
  checkpointProtocol: 'openai-chat',
  createModel(responder) {
    const calls: FakeSdkCall[] = [];
    const create = vi.fn(async (payload: unknown, options?: unknown) => {
      const signal = readRecord(options).signal;
      calls.push({
        payload,
        options,
        signalAbortedAtCall: signal instanceof AbortSignal && signal.aborted,
      });
      return responder(calls.length - 1, payload);
    });
    return {
      model: new OpenAIChatModel({
        model: 'offline-chat-protocol-matrix',
        client: { chat: { completions: { create } } } as never,
      }),
      calls,
    };
  },
  toolResponse: chatToolResponse,
  extractToolOutputs: extractChatToolOutputs,
  toolDefinition(payload, name) {
    const tools = readArray(readRecord(payload).tools);
    for (const tool of tools) {
      const record = readRecord(tool);
      const fn = readRecord(record.function);
      if (fn.name === name) return fn;
    }
    return undefined;
  },
  assertWire(payload) {
    const record = readRecord(payload);
    expect(record.messages).toBeInstanceOf(Array);
    expect(record).not.toHaveProperty('input');
  },
};

const responsesSpec: ProtocolSpec<OpenAIResponsesProtocol> = {
  kind: 'responses',
  checkpointProtocol: 'openai-responses',
  createModel(responder) {
    const calls: FakeSdkCall[] = [];
    const create = vi.fn(async (payload: unknown, options?: unknown) => {
      const signal = readRecord(options).signal;
      calls.push({
        payload,
        options,
        signalAbortedAtCall: signal instanceof AbortSignal && signal.aborted,
      });
      return responder(calls.length - 1, payload);
    });
    return {
      model: new OpenAIResponsesModel({
        model: 'offline-responses-protocol-matrix',
        client: { responses: { create } } as never,
      }),
      calls,
    };
  },
  toolResponse: responsesToolResponse,
  extractToolOutputs: extractResponsesToolOutputs,
  toolDefinition(payload, name) {
    const tools = readArray(readRecord(payload).tools);
    for (const tool of tools) {
      const record = readRecord(tool);
      if (record.name === name) return record;
    }
    return undefined;
  },
  assertWire(payload) {
    const record = readRecord(payload);
    expect(record.input).toBeInstanceOf(Array);
    expect(record).not.toHaveProperty('messages');
  },
};

describe('Local Agent OpenAI adapter protocol matrix', () => {
  acceptanceIt('PRO-01.l4.chat-chat.local', 'chat-parent.chat-child', async () => {
    assertNetworkDenyGuard();
    await runProtocolCase(chatSpec, chatSpec);
  });

  acceptanceIt('PRO-02.l4.chat-responses.local', 'chat-parent.responses-child', async () => {
    assertNetworkDenyGuard();
    await runProtocolCase(chatSpec, responsesSpec);
  });

  acceptanceIt('PRO-03.l4.responses-chat.local', 'responses-parent.chat-child', async () => {
    assertNetworkDenyGuard();
    await runProtocolCase(responsesSpec, chatSpec);
  });

  acceptanceIt(
    'PRO-04.l4.responses-responses.local',
    'responses-parent.responses-child',
    async () => {
      assertNetworkDenyGuard();
      await runProtocolCase(responsesSpec, responsesSpec);
    },
  );
});

function assertNetworkDenyGuard(): void {
  expect(
    Reflect.get(globalThis, Symbol.for('maneeagent.testkit.network-deny-owner.v1')),
  ).toBeDefined();
}

async function runProtocolCase<PParent extends AgentProtocol, PChild extends AgentProtocol>(
  parentSpec: ProtocolSpec<PParent>,
  childSpec: ProtocolSpec<PChild>,
): Promise<void> {
  const sessionId = `protocol-${parentSpec.kind}-parent-${childSpec.kind}-child`;
  const executorName = 'local-protocol-matrix';
  const parentOnlyMarker = `parent-transcript-must-not-leak:${sessionId}`;
  const completionOrder: Lane[] = [];
  const childHarnesses = new Map<Lane, AdapterHarness<PChild>>();
  const childRequests = new Map<Lane, Readonly<{ input: ProtocolInput; signal: AbortSignal }>>();
  const stateStore = new RecordingRuntimeStateStore();
  let ordinaryToolActive = false;
  let ordinaryToolSettled = false;
  let ordinaryToolCalls = 0;
  let releaseSlow = (): void => undefined;
  const slowGate = new Promise<void>((resolve) => {
    releaseSlow = resolve;
  });

  const registration = createLocalAgentRunnerRegistration({
    definition,
    runnerId: `protocol-${childSpec.kind}-runner`,
    runnerVersion: '2.0.0',
    createAgent({ request }) {
      const input = inputSchema.parse(request.input);
      expect(ordinaryToolActive).toBe(false);
      expect(ordinaryToolSettled).toBe(true);
      const durableOrdinaryCall = stateStore
        .snapshot(sessionId)
        .runs[0]?.pendingBatch?.calls.find(({ callId }) => callId === parentOrdinaryCallId());
      expect(durableOrdinaryCall).toMatchObject({
        kind: 'tool',
        status: 'settled',
      });
      childRequests.set(input.lane, Object.freeze({ input, signal: request.signal }));
      const harness = childSpec.createModel(async (round, payload) => {
        childSpec.assertWire(payload);
        assertNoRuntimeFields(payload);
        expect(JSON.stringify(payload)).not.toContain(parentOnlyMarker);

        if (round === 0) {
          if (input.lane === 'slow') await slowGate;
          return childSpec.toolResponse([
            {
              callId: childResultCallId(input.lane),
              name: 'agent-result',
              input: { result: expectedOutput(input) },
            },
          ]);
        }
        if (round === 1) {
          completionOrder.push(input.lane);
          if (input.lane === 'fast') releaseSlow();
          return childSpec.toolResponse([
            {
              callId: childEndCallId(input.lane),
              name: 'end-agent',
              input: {},
            },
          ]);
        }
        throw new Error(`Unexpected ${childSpec.kind} child provider round ${round}.`);
      });
      childHarnesses.set(input.lane, harness);
      return new Agent<PChild>({
        llm: harness.model,
        maxIterations: 3,
        systemPrompts: ['Submit the typed proof with agent-result, then call end-agent alone.'],
      });
    },
    buildInput(request) {
      const input = inputSchema.parse(request.input);
      return `child-only:${input.lane}:${input.sequence}:${input.payload.marker}`;
    },
  });
  const executor = new MemorySubAgentExecutor({
    registry: new LocalSubAgentRunnerRegistry([registration]),
    name: executorName,
  });
  const runtime = createSubAgentRuntime({
    sessionId,
    activeDefinitions: [definition],
    executors: [executor],
    stateStore,
  });
  await runtime.init();

  let parentResultPayload: unknown;
  const parentHarness = parentSpec.createModel((round, payload) => {
    parentSpec.assertWire(payload);
    assertNoRuntimeFields(payload);
    if (round === 0) {
      assertAgentToolSchema(parentSpec.toolDefinition(payload, 'agent'));
      expect(parentSpec.toolDefinition(payload, 'agent-result')).toBeUndefined();
      return parentSpec.toolResponse([
        {
          callId: parentOrdinaryCallId(),
          name: 'ordinary-proof',
          input: { marker: 'ordinary-first' },
        },
        ...fixtures.map((input) => ({
          callId: parentCallId(input.lane),
          name: 'agent',
          input: {
            subAgent: definition.name,
            executor: executorName,
            input,
          },
        })),
      ]);
    }
    if (round === 1) {
      parentResultPayload = payload;
      return parentSpec.toolResponse([
        {
          callId: `parent-end-${parentSpec.kind}-${childSpec.kind}`,
          name: 'end-agent',
          input: {},
        },
      ]);
    }
    throw new Error(`Unexpected ${parentSpec.kind} parent provider round ${round}.`);
  });
  const parent = new Agent<PParent>({
    llm: parentHarness.model,
    subAgentRuntime: runtime,
    sessionId,
    maxIterations: 3,
  });
  const ordinaryTool: ToolRuntimeDefinition = {
    name: 'ordinary-proof',
    description: 'Settle an ordinary runtime Tool before child placement begins.',
    parameters: z.object({ marker: z.literal('ordinary-first') }).strict(),
    handler: async () => {
      ordinaryToolCalls += 1;
      ordinaryToolActive = true;
      await Promise.resolve();
      ordinaryToolActive = false;
      ordinaryToolSettled = true;
      return { proof: 'ordinary-settled' };
    },
  };
  parent.tools.push(ordinaryTool);
  parent.init();
  const controller = new AbortController();
  const outcome = await parent.agent(parentOnlyMarker, { signal: controller.signal });

  if (outcome.status !== 'succeeded') {
    throw new Error('Protocol matrix root run did not succeed.');
  }
  expect(outcome).toMatchObject({ status: 'succeeded', sessionId });
  expect(parentHarness.calls).toHaveLength(2);
  assertSdkSignals(parentHarness.calls);
  expect(ordinaryToolCalls).toBe(1);
  expect(ordinaryToolSettled).toBe(true);
  expect(completionOrder).toEqual(['fast', 'slow']);
  expect([...childHarnesses.keys()].sort()).toEqual(['fast', 'slow']);

  const parentOutputs = parentSpec.extractToolOutputs(parentResultPayload);
  expect(parentOutputs.map(({ callId }) => callId)).toEqual([
    parentOrdinaryCallId(),
    parentCallId('slow'),
    parentCallId('fast'),
  ]);
  expect(JSON.parse(parentOutputs[0]!.output)).toEqual({ proof: 'ordinary-settled' });
  const terminalResults = parentOutputs
    .slice(1)
    .map(({ output }) => JSON.parse(output) as JsonValue);
  expect(terminalResults).toEqual(
    fixtures.map((input) =>
      expect.objectContaining({
        status: 'succeeded',
        executor: executorName,
        output: expectedOutput(input),
      }),
    ),
  );
  expect(JSON.stringify(parentResultPayload)).not.toContain('child-result-');
  expect(JSON.stringify(parentResultPayload)).not.toContain('child-end-');

  const tasks = await stateStore.listTasksByRun(sessionId, outcome.runId);
  expect(tasks).toHaveLength(fixtures.length);
  for (const input of fixtures) {
    const task = tasks.find((candidate) => candidate.inputHash === canonicalJsonSha256(input));
    expect(task).toBeDefined();
    expect(task?.input).toEqual(input);
    expect(task?.inputHash).toBe(canonicalJsonSha256(input));
    expect(task?.resultReceipt).toMatchObject({
      callId: childResultCallId(input.lane),
      outputHash: canonicalJsonSha256(expectedOutput(input)),
    });
    expect(task?.childCheckpoint?.protocolContext.protocol).toBe(childSpec.checkpointProtocol);
  }
  const storedRun = await stateStore.loadRun(sessionId, outcome.runId);
  expect(storedRun?.protocolContext.protocol).toBe(parentSpec.checkpointProtocol);

  for (const input of fixtures) {
    const harness = childHarnesses.get(input.lane);
    const request = childRequests.get(input.lane);
    expect(harness?.calls).toHaveLength(2);
    expect(request?.input).toEqual(input);
    expect(request?.signal).toBeInstanceOf(AbortSignal);
    assertSdkSignals(harness?.calls ?? []);
    const resultOutputs = childSpec.extractToolOutputs(harness?.calls[1]?.payload);
    expect(resultOutputs).toHaveLength(1);
    expect(resultOutputs[0]?.callId).toBe(childResultCallId(input.lane));
    expect(JSON.parse(resultOutputs[0]!.output)).toMatchObject({
      ok: true,
      status: 'accepted',
      outputHash: canonicalJsonSha256(expectedOutput(input)),
    });
  }
}

function expectedOutput(input: ProtocolInput): ProtocolOutput {
  return {
    lane: input.lane,
    sequence: input.sequence,
    proof: `proof:${input.payload.marker}`,
  };
}

function parentCallId(lane: Lane): string {
  return `parent-agent-${lane}`;
}

function parentOrdinaryCallId(): string {
  return 'parent-ordinary-proof';
}

function childResultCallId(lane: Lane): string {
  return `child-result-${lane}`;
}

function childEndCallId(lane: Lane): string {
  return `child-end-${lane}`;
}

function chatToolResponse(calls: readonly ProviderToolCall[]): unknown {
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: calls.map((call) => ({
            id: call.callId,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.input) },
          })),
        },
      },
    ],
  };
}

function responsesToolResponse(calls: readonly ProviderToolCall[]): unknown {
  return {
    output: calls.map((call) => ({
      type: 'function_call',
      id: `item-${call.callId}`,
      call_id: call.callId,
      name: call.name,
      arguments: JSON.stringify(call.input),
      status: 'completed',
    })),
  };
}

function extractChatToolOutputs(payload: unknown): readonly ProviderToolOutput[] {
  return readArray(readRecord(payload).messages).flatMap((message) => {
    const record = readRecord(message);
    return record.role === 'tool' && typeof record.tool_call_id === 'string'
      ? [
          {
            callId: record.tool_call_id,
            output:
              typeof record.content === 'string' ? record.content : JSON.stringify(record.content),
          },
        ]
      : [];
  });
}

function extractResponsesToolOutputs(payload: unknown): readonly ProviderToolOutput[] {
  return readArray(readRecord(payload).input).flatMap((message) => {
    const record = readRecord(message);
    return record.type === 'function_call_output' && typeof record.call_id === 'string'
      ? [
          {
            callId: record.call_id,
            output:
              typeof record.output === 'string' ? record.output : JSON.stringify(record.output),
          },
        ]
      : [];
  });
}

function assertAgentToolSchema(tool: Record<string, unknown> | undefined): void {
  expect(tool).toBeDefined();
  expect(tool?.strict).toBe(true);
  const parameters = readRecord(tool?.parameters);
  expect(parameters).toMatchObject({
    type: 'object',
    required: ['subAgent', 'executor', 'input'],
    additionalProperties: false,
  });
  const branches = readArray(parameters.oneOf);
  expect(branches).toHaveLength(1);
  expect(Object.keys(readRecord(readRecord(branches[0]).properties)).sort()).toEqual([
    'executor',
    'input',
    'subAgent',
  ]);
}

function assertNoRuntimeFields(payload: unknown): void {
  const record = readRecord(payload);
  expect(record).not.toHaveProperty('signal');
  expect(record).not.toHaveProperty('deadlineAt');
  expect(record).not.toHaveProperty('runtime');
}

function assertSdkSignals(calls: readonly FakeSdkCall[]): void {
  expect(calls.length).toBeGreaterThan(0);
  const signals = calls.map(({ options }) => readRecord(options).signal);
  expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
  expect(signals.every((signal) => signal === signals[0])).toBe(true);
  expect(calls.every(({ signalAbortedAtCall }) => !signalAbortedAtCall)).toBe(true);
}

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}
