import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';

import {
  Agent,
  OpenAIChatModel,
  OpenAIResponsesModel,
  type AgentProtocol,
  type AgentRunOutcome,
  type ContextOf,
  type ModelGenerateRequest,
  type ModelGenerateResult,
  type OpenAIChatContext,
  type OpenAIChatProtocol,
  type OpenAIChatRawToolCall,
  type OpenAIResponsesFunctionCall,
  type OpenAIResponsesProtocol,
  type ToolPayloadCompactor,
  type ToolRuntimeDefinition,
} from '../src';
import {
  assistant,
  endResponse,
  MockModel,
  response,
  toolCall,
  type TestProtocol,
} from './helpers/mock-models';

function succeededContext<P extends AgentProtocol>(
  outcome: AgentRunOutcome<P>,
): readonly ContextOf<P>[] {
  expect(outcome.status).toBe('succeeded');
  if (outcome.status !== 'succeeded') {
    throw new Error(`Expected a succeeded Agent run, received ${outcome.status}.`);
  }
  return outcome.context;
}

async function expectFailedRun<P extends AgentProtocol>(
  promise: Promise<AgentRunOutcome<P>>,
  expectedCode = 'INTERNAL_ERROR',
): Promise<void> {
  const outcome = await promise;
  expect(outcome).toMatchObject({ status: 'failed', error: { code: expectedCode } });
}

type GenerateEntry<P extends AgentProtocol> =
  | ModelGenerateResult<P>
  | ((
      request: ModelGenerateRequest<P>,
      requestNumber: number,
    ) => ModelGenerateResult<P> | Promise<ModelGenerateResult<P>>);

class QueueChatModel extends OpenAIChatModel {
  readonly requests: ModelGenerateRequest<OpenAIChatProtocol>[] = [];

  constructor(private readonly entries: GenerateEntry<OpenAIChatProtocol>[]) {
    super({ apiKey: 'offline-test-key', model: 'offline-chat-model' });
  }

  override async generate(
    request: ModelGenerateRequest<OpenAIChatProtocol>,
  ): Promise<ModelGenerateResult<OpenAIChatProtocol>> {
    const snapshot = snapshotRequest(request);
    this.requests.push(snapshot);
    const entry = this.entries.shift();

    if (!entry) {
      throw new Error('QueueChatModel response queue is empty.');
    }

    return typeof entry === 'function' ? entry(snapshot, this.requests.length) : entry;
  }
}

class QueueResponsesModel extends OpenAIResponsesModel {
  readonly requests: ModelGenerateRequest<OpenAIResponsesProtocol>[] = [];

  constructor(private readonly entries: GenerateEntry<OpenAIResponsesProtocol>[]) {
    super({ apiKey: 'offline-test-key', model: 'offline-responses-model' });
  }

  override async generate(
    request: ModelGenerateRequest<OpenAIResponsesProtocol>,
  ): Promise<ModelGenerateResult<OpenAIResponsesProtocol>> {
    const snapshot = snapshotRequest(request);
    this.requests.push(snapshot);
    const entry = this.entries.shift();

    if (!entry) {
      throw new Error('QueueResponsesModel response queue is empty.');
    }

    return typeof entry === 'function' ? entry(snapshot, this.requests.length) : entry;
  }
}

function snapshotRequest<P extends AgentProtocol>(
  request: ModelGenerateRequest<P>,
): ModelGenerateRequest<P> {
  return {
    context: [...request.context],
    tools: [...request.tools],
    ...('purpose' in request ? { purpose: request.purpose } : {}),
  };
}

function runtimeTool(
  name: string,
  handler: ToolRuntimeDefinition['handler'],
  parameters: ToolRuntimeDefinition['parameters'] = z.object({}),
): ToolRuntimeDefinition {
  return {
    name,
    description: `${name} fixture`,
    parameters,
    handler,
  };
}

function chatRawCall(id: string, name: string, argumentsText = '{}'): OpenAIChatRawToolCall {
  return {
    id,
    type: 'function',
    function: { name, arguments: argumentsText },
  };
}

function chatCalls(
  ...calls: readonly OpenAIChatRawToolCall[]
): ModelGenerateResult<OpenAIChatProtocol> {
  return {
    messages: [
      {
        role: 'assistant',
        content: null,
        tool_calls: calls,
      },
    ],
  };
}

function chatEnd(id = 'chat-end'): ModelGenerateResult<OpenAIChatProtocol> {
  return chatCalls(chatRawCall(id, 'end-agent'));
}

function responsesCall(
  id: string,
  name: string,
  argumentsText = '{}',
): OpenAIResponsesFunctionCall {
  return {
    type: 'function_call',
    call_id: id,
    name,
    arguments: argumentsText,
    id: `provider-${id}`,
    status: 'completed',
  };
}

function responsesCalls(
  ...calls: readonly OpenAIResponsesFunctionCall[]
): ModelGenerateResult<OpenAIResponsesProtocol> {
  return { messages: calls };
}

function responsesEnd(id = 'responses-end'): ModelGenerateResult<OpenAIResponsesProtocol> {
  return responsesCalls(responsesCall(id, 'end-agent'));
}

function persistentChatContext(
  request: ModelGenerateRequest<OpenAIChatProtocol>,
): readonly OpenAIChatContext[] {
  return request.context.filter((message) => message.role !== 'system');
}

function createGate(): {
  readonly promise: Promise<void>;
  readonly release: () => void;
} {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });

  return { promise, release };
}

describe('tool payload compact configuration', () => {
  it('preserves the omitted/default-object/explicit-disabled init tri-state', async () => {
    const longArguments = JSON.stringify({ value: 'x'.repeat(9_000) });

    const omittedModel = new MockModel([
      response(assistant('', [toolCall('omitted-1', 'echo', longArguments)])),
    ]);
    const omitted = new Agent<TestProtocol>({
      llm: omittedModel,
      maxIterations: 1,
    });
    omitted.tools.push(runtimeTool('echo', () => 'short', z.object({ value: z.string() })));
    omitted.init();

    await expectFailedRun(omitted.agent('omitted'), 'LIMIT_EXCEEDED');

    const disabledModel = new MockModel([
      response(assistant('', [toolCall('disabled-1', 'echo', longArguments)])),
    ]);
    const disabled = new Agent<TestProtocol>({
      llm: disabledModel,
      maxIterations: 1,
      contextCompact: { toolInput: false, toolResult: false },
    });
    disabled.tools.push(runtimeTool('echo', () => 'short', z.object({ value: z.string() })));
    disabled.init();

    await expectFailedRun(disabled.agent('disabled'), 'LIMIT_EXCEEDED');

    const defaultsModel = new MockModel([
      response(assistant('', [toolCall('defaults-1', 'echo', longArguments)])),
    ]);
    const defaults = new Agent<TestProtocol>({
      llm: defaultsModel,
      maxIterations: 1,
      contextCompact: {},
    });
    defaults.tools.push(runtimeTool('echo', () => 'short', z.object({ value: z.string() })));
    defaults.init();

    await expectFailedRun(defaults.agent('defaults'));
  });

  it('validates malformed compact options during init, not construction', () => {
    const invalidShape = new Agent<TestProtocol>({
      llm: new MockModel(),
      contextCompact: null as never,
    });
    expect(() => invalidShape.init()).toThrow('contextCompact must be a non-null object');

    const invalidLimits = new Agent<TestProtocol>({
      llm: new MockModel(),
      contextCompact: {
        toolInput: { strategy: 'default', thresholdChars: 512, targetChars: 512 },
      },
    });
    expect(() => invalidLimits.init()).toThrow('thresholdChars must be greater than targetChars');

    const nullLimit = new Agent<TestProtocol>({
      llm: new MockModel(),
      contextCompact: {
        toolInput: { strategy: 'default', targetChars: null as never },
      },
    });
    expect(() => nullLimit.init()).toThrow('targetChars must be a safe integer');
  });
});

describe('tool payload compact vertical integration', () => {
  it('executes original Chat arguments, preserves raw history, and rewrites active context only', async () => {
    const originalArguments = JSON.stringify({ value: 'the original argument' });
    const originalResult = 'the original result';
    const firstCall = chatRawCall('chat-echo-1', 'echo', originalArguments);
    const firstAssistant = chatCalls(firstCall).messages[0] as OpenAIChatContext;
    const model = new QueueChatModel([{ messages: [firstAssistant] }, chatEnd()]);
    const handler = vi.fn((parameters: unknown) => {
      void parameters;
      return originalResult;
    });
    const seenInfo: Parameters<ToolPayloadCompactor>[1][] = [];
    const agent = new Agent<OpenAIChatProtocol>({
      llm: model,
      contextCompact: {
        toolInput: (original, info) => {
          if (info.call.name !== 'echo') return undefined;
          expect(original).toBe(originalArguments);
          seenInfo.push(info);
          return '{"compacted":true}';
        },
        toolResult: (original, info) => {
          if (info.call.name !== 'echo') return undefined;
          expect(original).toBe(originalResult);
          seenInfo.push(info);
          return '[compacted result]';
        },
      },
    });
    agent.tools.push(
      runtimeTool(
        'echo',
        (parameters) => {
          handler(parameters);
          return originalResult;
        },
        z.object({ value: z.string() }),
      ),
    );
    agent.init();

    const active = succeededContext(await agent.agent('start'));
    const raw = agent.getHistory();
    const rawAssistant = raw.find(
      (message) => message.role === 'assistant' && message.tool_calls?.[0]?.id === firstCall.id,
    );
    const rawResult = raw.find(
      (message) => message.role === 'tool' && message.tool_call_id === firstCall.id,
    );
    const activeAssistant = active.find(
      (message) => message.role === 'assistant' && message.tool_calls?.[0]?.id === firstCall.id,
    );
    const activeResult = active.find(
      (message) => message.role === 'tool' && message.tool_call_id === firstCall.id,
    );

    expect(handler).toHaveBeenCalledWith({ value: 'the original argument' });
    expect(rawAssistant).toBe(firstAssistant);
    expect(rawAssistant?.role === 'assistant' && rawAssistant.tool_calls?.[0]).toBe(firstCall);
    expect(
      rawAssistant?.role === 'assistant' && rawAssistant.tool_calls?.[0]?.type === 'function'
        ? rawAssistant.tool_calls[0].function.arguments
        : undefined,
    ).toBe(originalArguments);
    expect(rawResult?.role === 'tool' ? rawResult.content : undefined).toBe(originalResult);
    expect(activeAssistant).not.toBe(rawAssistant);
    expect(
      activeAssistant?.role === 'assistant' && activeAssistant.tool_calls?.[0]?.type === 'function'
        ? activeAssistant.tool_calls[0].function.arguments
        : undefined,
    ).toBe('{"compacted":true}');
    expect(activeResult?.role === 'tool' ? activeResult.content : undefined).toBe(
      '[compacted result]',
    );
    expect(model.requests[1] && persistentChatContext(model.requests[1])).toContain(
      activeAssistant,
    );
    expect(seenInfo).toHaveLength(2);
    for (const info of seenInfo) {
      expect(Object.isFrozen(info)).toBe(true);
      expect(Object.isFrozen(info.call)).toBe(true);
      expect(info.iteration).toBe(0);
      expect(info.call).not.toBe(firstCall);
      expect(info.call).toEqual({
        id: firstCall.id,
        name: 'echo',
        arguments: originalArguments,
      });
    }
  });

  it('mixes a custom Responses input compactor with the default result compactor', async () => {
    const originalArguments = JSON.stringify({ amount: 7 });
    const originalResult = 'result:'.concat('r'.repeat(2_000));
    const call = responsesCall('responses-produce-1', 'produce', originalArguments);
    const model = new QueueResponsesModel([responsesCalls(call), responsesEnd()]);
    const inputCompactor = vi.fn<ToolPayloadCompactor>((original, info) =>
      info.call.name === 'produce' ? '{"amount":"compacted"}' : undefined,
    );
    const handler = vi.fn(() => originalResult);
    const agent = new Agent<OpenAIResponsesProtocol>({
      llm: model,
      contextCompact: {
        toolInput: inputCompactor,
        toolResult: {
          strategy: 'default',
          thresholdChars: 600,
          targetChars: 512,
        },
      },
    });
    agent.tools.push(runtimeTool('produce', handler, z.object({ amount: z.number() })));
    agent.init();

    const active = succeededContext(await agent.agent('start'));
    const raw = agent.getHistory();
    const activeCall = active.find(
      (message) => message.type === 'function_call' && message.call_id === call.call_id,
    );
    const activeResult = active.find(
      (message) => message.type === 'function_call_output' && message.call_id === call.call_id,
    );
    const rawCall = raw.find(
      (message) => message.type === 'function_call' && message.call_id === call.call_id,
    );
    const rawResult = raw.find(
      (message) => message.type === 'function_call_output' && message.call_id === call.call_id,
    );

    expect(handler).toHaveBeenCalledWith({ amount: 7 });
    expect(rawCall).toBe(call);
    expect(rawCall?.type === 'function_call' ? rawCall.arguments : undefined).toBe(
      originalArguments,
    );
    expect(rawResult?.type === 'function_call_output' ? rawResult.output : undefined).toBe(
      originalResult,
    );
    expect(activeCall?.type === 'function_call' ? activeCall.arguments : undefined).toBe(
      '{"amount":"compacted"}',
    );
    expect(activeResult?.type).toBe('function_call_output');
    if (activeResult?.type !== 'function_call_output' || typeof activeResult.output !== 'string') {
      throw new Error('Expected a compacted string function_call_output.');
    }
    expect(activeResult.output.length).toBeLessThanOrEqual(512);
    expect(activeResult.output).toContain('context compacted');
    expect(inputCompactor).toHaveBeenCalledWith(
      originalArguments,
      expect.objectContaining({ kind: 'tool_input', iteration: 0 }),
    );

    const secondRequest = model.requests[1];
    expect(secondRequest?.context).toContain(activeCall);
    expect(secondRequest?.context).toContain(activeResult);
  });

  it('records and compacts every tool error path in model call order', async () => {
    const calls = [
      chatRawCall('error-unknown', 'missing'),
      chatRawCall('error-json', 'validated', '{'),
      chatRawCall('error-schema', 'validated', '{"value":1}'),
      chatRawCall('error-before', 'canceled'),
      chatRawCall('error-handler', 'throws'),
      chatRawCall('error-after', 'after-error'),
    ] as const;
    const model = new QueueChatModel([chatCalls(...calls), chatEnd()]);
    const canceledHandler = vi.fn();
    const compactOrder: string[] = [];
    const compactedIds = new Set(calls.map((call) => call.id));
    const agent = new Agent<OpenAIChatProtocol>({
      llm: model,
      contextCompact: {
        toolInput: (_original, info) => {
          if (!compactedIds.has(info.call.id)) return undefined;
          compactOrder.push(`${info.call.id}:input`);
          return JSON.stringify({ compactedInput: info.call.id });
        },
        toolResult: (_original, info) => {
          if (!compactedIds.has(info.call.id)) return undefined;
          compactOrder.push(`${info.call.id}:result`);
          return `compacted-result:${info.call.id}`;
        },
      },
    });
    agent.tools.push(
      runtimeTool(
        'validated',
        (parameters) => (parameters as { value: string }).value,
        z.object({ value: z.string() }),
      ),
      runtimeTool('canceled', canceledHandler),
      runtimeTool('throws', () => {
        throw new Error('handler exploded');
      }),
      runtimeTool('after-error', () => 'handler succeeded'),
    );
    agent.onBeforeToolCall(
      'canceled',
      () => {
        throw new Error('before rejected');
      },
      { await: true, errorCancel: true },
    );
    agent.onAfterToolCall(
      'after-error',
      () => {
        throw new Error('after rejected');
      },
      { await: true },
    );
    agent.init();

    const active = succeededContext(await agent.agent('start'));

    expect(canceledHandler).not.toHaveBeenCalled();
    expect(compactOrder).toEqual(
      calls.flatMap((call) => [`${call.id}:input`, `${call.id}:result`]),
    );
    for (const call of calls) {
      const activeInput = active.find(
        (message) =>
          message.role === 'assistant' &&
          message.tool_calls?.some((candidate) => candidate.id === call.id),
      );
      const targetCall =
        activeInput?.role === 'assistant'
          ? activeInput.tool_calls?.find((candidate) => candidate.id === call.id)
          : undefined;
      const activeOutput = active.find(
        (message) => message.role === 'tool' && message.tool_call_id === call.id,
      );

      expect(targetCall?.type === 'function' ? targetCall.function.arguments : undefined).toBe(
        JSON.stringify({ compactedInput: call.id }),
      );
      expect(activeOutput?.role === 'tool' ? activeOutput.content : undefined).toBe(
        `compacted-result:${call.id}`,
      );
    }

    const rawOutputs = agent
      .getHistory()
      .filter((message) => message.role === 'tool' && compactedIds.has(message.tool_call_id))
      .map((message) => (message.role === 'tool' ? message.content : ''));
    expect(rawOutputs[0]).toContain('Unknown tool: missing');
    expect(rawOutputs[1]).toMatch(/JSON|position|property name/iu);
    expect(rawOutputs[2]).toContain('value');
    expect(rawOutputs[3]).toContain('before rejected');
    expect(rawOutputs[4]).toBe('handler exploded');
    expect(rawOutputs[5]).toBe('handler succeeded');
  });

  it('rolls back the whole batch when a later custom compactor fails', async () => {
    const calls = [
      chatRawCall('rollback-1', 'echo', '{"value":"one"}'),
      chatRawCall('rollback-2', 'echo', '{"value":"two"}'),
    ] as const;
    const sourceAssistant = chatCalls(...calls).messages[0] as OpenAIChatContext;
    const model = new QueueChatModel([{ messages: [sourceAssistant] }]);
    const agent = new Agent<OpenAIChatProtocol>({
      llm: model,
      contextCompact: {
        toolInput: (_original, info) => JSON.stringify({ compacted: info.call.id }),
        toolResult: (_original, info) => {
          if (info.call.id === 'rollback-2') {
            throw new Error('second result compactor failed');
          }
          return `compacted:${info.call.id}`;
        },
      },
    });
    agent.tools.push(
      runtimeTool(
        'echo',
        (parameters) => (parameters as { value: string }).value,
        z.object({ value: z.string() }),
      ),
    );
    agent.init();

    await expectFailedRun(agent.agent('start'));

    const raw = agent.getHistory();
    const active = agent.getContext();
    expect(active).toHaveLength(raw.length);
    active.forEach((message, index) => expect(message).toBe(raw[index]));
    expect(raw).toContain(sourceAssistant);
    expect(
      sourceAssistant.role === 'assistant'
        ? sourceAssistant.tool_calls?.map((call) =>
            call.type === 'function' ? call.function.arguments : undefined,
          )
        : [],
    ).toEqual(['{"value":"one"}', '{"value":"two"}']);
    expect(
      raw
        .filter((message) => message.role === 'tool')
        .map((message) => (message.role === 'tool' ? message.content : '')),
    ).toEqual(['one', 'two']);
  });

  it('aborts cleanly when a Model lacks the rewrite capability', async () => {
    const source = assistant('', [toolCall('unsupported-1', 'echo', '{"value":"raw"}')]);
    const model = new MockModel([response(source)]);
    const agent = new Agent<TestProtocol>({
      llm: model,
      contextCompact: {
        toolInput: () => '{"value":"compact"}',
        toolResult: false,
      },
    });
    agent.tools.push(
      runtimeTool(
        'echo',
        (parameters) => (parameters as { value: string }).value,
        z.object({ value: z.string() }),
      ),
    );
    agent.init();

    await expectFailedRun(agent.agent('start'));
    const raw = agent.getHistory();
    const active = agent.getContext();
    active.forEach((message, index) => expect(message).toBe(raw[index]));
    expect(raw).toContain(source);
    expect(
      raw.find((message) => message.kind === 'tool' && message.callId === 'unsupported-1'),
    ).toEqual({ kind: 'tool', callId: 'unsupported-1', output: 'raw' });
  });

  it('rejects a CAS commit after concurrent append and retains every original entry', async () => {
    const call = chatRawCall('cas-1', 'echo', '{"value":"raw"}');
    const model = new QueueChatModel([chatCalls(call)]);
    let appended = false;
    const agent = new Agent<OpenAIChatProtocol>({
      llm: model,
      contextCompact: {
        toolInput: () => {
          if (!appended) {
            appended = true;
            agent.appendContext({ role: 'user', content: 'raced during compact' });
          }
          return '{"value":"compact"}';
        },
        toolResult: false,
      },
    });
    agent.tools.push(
      runtimeTool(
        'echo',
        (parameters) => (parameters as { value: string }).value,
        z.object({ value: z.string() }),
      ),
    );
    agent.init();

    await expectFailedRun(agent.agent('start'));

    const raw = agent.getHistory();
    const active = agent.getContext();
    active.forEach((message, index) => expect(message).toBe(raw[index]));
    expect(raw.at(-1)).toEqual({ role: 'user', content: 'raced during compact' });
    expect(
      raw.find((message) => message.role === 'assistant' && message.tool_calls?.[0]?.id === call.id)
        ?.role === 'assistant'
        ? (
            raw.find(
              (message) => message.role === 'assistant' && message.tool_calls?.[0]?.id === call.id,
            ) as { tool_calls: readonly OpenAIChatRawToolCall[] }
          ).tool_calls[0]?.function.arguments
        : undefined,
    ).toBe('{"value":"raw"}');
  });
});

describe('tool compact loop finalization', () => {
  it('waits for non-awaited listeners before snapshotting and compacting', async () => {
    const listenerGate = createGate();
    let listenerStarted!: () => void;
    const listenerDidStart = new Promise<void>((resolve) => {
      listenerStarted = resolve;
    });
    const call = chatRawCall('listener-1', 'echo', '{"value":"raw"}');
    const model = new QueueChatModel([chatCalls(call), chatEnd()]);
    const compactor = vi.fn<ToolPayloadCompactor>((_original, info) =>
      info.call.name === 'echo' ? `compact:${info.kind}` : undefined,
    );
    const agent = new Agent<OpenAIChatProtocol>({
      llm: model,
      contextCompact: { toolInput: compactor, toolResult: compactor },
    });
    agent.tools.push(runtimeTool('echo', () => 'raw result'));
    agent.onAfterToolCall('echo', async () => {
      listenerStarted();
      await listenerGate.promise;
      agent.appendContext({ role: 'user', content: 'listener finalized' });
    });
    agent.init();

    const run = agent.agent('start');
    await listenerDidStart;

    expect(compactor).not.toHaveBeenCalled();
    let settled = false;
    void run.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    listenerGate.release();
    const active = succeededContext(await run);

    expect(compactor).toHaveBeenCalled();
    expect(active).toContainEqual({ role: 'user', content: 'listener finalized' });
    expect(
      active.find((message) => message.role === 'tool' && message.tool_call_id === call.id)
        ?.role === 'tool'
        ? (
            active.find(
              (message) => message.role === 'tool' && message.tool_call_id === call.id,
            ) as { content: string }
          ).content
        : undefined,
    ).toBe('compact:tool_result');
  });

  it('keeps end-agent pending until compact commits successfully', async () => {
    const compactGate = createGate();
    let compactStarted!: () => void;
    const didStartCompact = new Promise<void>((resolve) => {
      compactStarted = resolve;
    });
    const model = new QueueChatModel([chatEnd('pending-end')]);
    const ended = vi.fn();
    const agent = new Agent<OpenAIChatProtocol>({
      llm: model,
      contextCompact: {
        toolInput: false,
        toolResult: async (original, info) => {
          expect(original).toBe('Agent 已结束。');
          expect(info.call.name).toBe('end-agent');
          compactStarted();
          await compactGate.promise;
          return '[compacted end result]';
        },
      },
    });
    agent.onAgentStatusChanged('ended', ended);
    agent.init();

    const run = agent.agent('start');
    await didStartCompact;
    expect(ended).not.toHaveBeenCalled();

    compactGate.release();
    const active = succeededContext(await run);

    expect(ended).toHaveBeenCalledOnce();
    expect(
      active.find((message) => message.role === 'tool' && message.tool_call_id === 'pending-end')
        ?.role === 'tool'
        ? (
            active.find(
              (message) => message.role === 'tool' && message.tool_call_id === 'pending-end',
            ) as { content: string }
          ).content
        : undefined,
    ).toBe('[compacted end result]');
    expect(
      agent
        .getHistory()
        .find((message) => message.role === 'tool' && message.tool_call_id === 'pending-end')
        ?.role === 'tool'
        ? (
            agent
              .getHistory()
              .find(
                (message) => message.role === 'tool' && message.tool_call_id === 'pending-end',
              ) as { content: string }
          ).content
        : undefined,
    ).toBe('Agent 已结束。');
  });

  it('clears a pending end request when compact fails', async () => {
    const model = new QueueChatModel([chatEnd('failed-end')]);
    const ended = vi.fn();
    const failed = vi.fn();
    const agent = new Agent<OpenAIChatProtocol>({
      llm: model,
      contextCompact: {
        toolInput: false,
        toolResult: () => {
          throw new Error('end compact failed');
        },
      },
    });
    agent.onAgentStatusChanged('ended', ended);
    agent.onAgentStatusChanged('failed', failed);
    agent.init();

    await expectFailedRun(agent.agent('start'));

    expect(ended).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledOnce();
    const raw = agent.getHistory();
    const active = agent.getContext();
    active.forEach((message, index) => expect(message).toBe(raw[index]));
    expect(
      raw.find((message) => message.role === 'tool' && message.tool_call_id === 'failed-end')
        ?.role === 'tool'
        ? (
            raw.find(
              (message) => message.role === 'tool' && message.tool_call_id === 'failed-end',
            ) as { content: string }
          ).content
        : undefined,
    ).toBe('Agent 已结束。');
  });

  it('uses the no-record fast path without invoking compactors or rewrite capability', async () => {
    const inputCompactor = vi.fn<ToolPayloadCompactor>(() => {
      throw new Error('must not run');
    });
    const resultCompactor = vi.fn<ToolPayloadCompactor>(() => {
      throw new Error('must not run');
    });
    const noCalls = assistant('there are no calls');
    const agent = new Agent<TestProtocol>({
      llm: new MockModel([response(noCalls)]),
      maxIterations: 1,
      contextCompact: { toolInput: inputCompactor, toolResult: resultCompactor },
    });
    agent.init();

    await expectFailedRun(agent.agent('start'), 'LIMIT_EXCEEDED');

    expect(inputCompactor).not.toHaveBeenCalled();
    expect(resultCompactor).not.toHaveBeenCalled();
    expect(agent.getHistory()).toContain(noCalls);
    expect(agent.getContext()).toContain(noCalls);
  });

  it('does not wait for non-awaited listeners when both compact kinds are disabled', async () => {
    const listenerGate = createGate();
    let listenerStarted!: () => void;
    const listenerDidStart = new Promise<void>((resolve) => {
      listenerStarted = resolve;
    });
    const model = new MockModel([
      response(assistant('', [toolCall('disabled-listener-1', 'echo')])),
      endResponse(),
    ]);
    const agent = new Agent<TestProtocol>({
      llm: model,
      contextCompact: { toolInput: false, toolResult: false },
    });
    agent.tools.push(runtimeTool('echo', () => 'result'));
    agent.onAfterToolCall('echo', async () => {
      listenerStarted();
      await listenerGate.promise;
    });
    agent.init();

    const run = agent.agent('start');
    await listenerDidStart;
    const outcome = await Promise.race([
      run.then(() => 'finished' as const),
      new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 100)),
    ]);
    listenerGate.release();

    expect(outcome).toBe('finished');
    await run;
  });

  it('never compacts standalone toolCall executions', async () => {
    const inputCompactor = vi.fn<ToolPayloadCompactor>(() => '{"value":"compact"}');
    const resultCompactor = vi.fn<ToolPayloadCompactor>(() => '[compact result]');
    const handler = vi.fn((parameters: unknown) => (parameters as { value: string }).value);
    const model = new QueueChatModel([]);
    const agent = new Agent<OpenAIChatProtocol>({
      llm: model,
      contextCompact: { toolInput: inputCompactor, toolResult: resultCompactor },
    });
    agent.tools.push(runtimeTool('echo', handler, z.object({ value: z.string() })));
    agent.init();
    const sourceMessage = chatCalls(chatRawCall('standalone-chat-1', 'echo', '{"value":"raw"}'))
      .messages[0] as OpenAIChatContext;
    const call = model.parseToolCalls([sourceMessage])[0];

    if (!call) {
      throw new Error('Expected a parsed standalone call.');
    }

    const result = await agent.toolCall(call);

    expect(handler).toHaveBeenCalledWith({ value: 'raw' });
    expect(inputCompactor).not.toHaveBeenCalled();
    expect(resultCompactor).not.toHaveBeenCalled();
    expect(result).toEqual({ role: 'tool', tool_call_id: 'standalone-chat-1', content: 'raw' });
    expect(agent.getHistory()).toEqual([result]);
    expect(agent.getContext()).toEqual([result]);
  });
});
