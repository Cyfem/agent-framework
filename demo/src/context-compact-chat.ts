/**
 * 离线 Chat Context Compact 验收套件。
 *
 * 所有场景都使用真实 Chat adapter 的 parser 与 copy-on-write rewrite，但不会发起网络请求。
 * 覆盖缺省/自定义/禁用三态、串行 callback 顺序，以及内置 Skill result 的默认跳过、
 * 显式加入和事务回滚。
 */
import {
  Agent,
  DEFAULT_TOOL_PAYLOAD_COMPACT_LIMITS,
  OpenAIChatModel,
  type AgentSkill,
  type ModelGenerateRequest,
  type ModelGenerateResult,
  type OpenAIChatContext,
  type OpenAIChatProtocol,
  type OpenAIChatRawToolCall,
  type ToolPayloadCompactor,
  type ToolPayloadReplacements,
} from '@manee/agent-framework';
import { z } from 'zod';

type GenerateEntry =
  | Error
  | ModelGenerateResult<OpenAIChatProtocol>
  | ((
      request: ModelGenerateRequest<OpenAIChatProtocol>,
      requestNumber: number,
    ) =>
      | ModelGenerateResult<OpenAIChatProtocol>
      | Promise<ModelGenerateResult<OpenAIChatProtocol>>);

class OfflineChatQueueModel extends OpenAIChatModel {
  readonly requests: ModelGenerateRequest<OpenAIChatProtocol>[] = [];

  constructor(private readonly entries: GenerateEntry[]) {
    super({ apiKey: 'offline-chat-key', model: 'offline-chat-model' });
  }

  override async generate(
    request: ModelGenerateRequest<OpenAIChatProtocol>,
  ): Promise<ModelGenerateResult<OpenAIChatProtocol>> {
    const snapshot = {
      context: [...request.context],
      tools: [...request.tools],
      ...('purpose' in request ? { purpose: request.purpose } : {}),
    } satisfies ModelGenerateRequest<OpenAIChatProtocol>;
    this.requests.push(snapshot);

    const entry = this.entries.shift();
    assertDemo(entry !== undefined, 'Offline Chat response queue is empty.');
    if (entry instanceof Error) throw entry;

    return typeof entry === 'function' ? entry(snapshot, this.requests.length) : entry;
  }
}

class FailingRewriteChatModel extends OfflineChatQueueModel {
  rewriteCalls = 0;

  override rewriteToolPayloads(
    context: readonly OpenAIChatContext[],
    replacements: ToolPayloadReplacements<OpenAIChatProtocol>,
  ): readonly OpenAIChatContext[] {
    void context;
    void replacements;
    this.rewriteCalls += 1;
    throw new Error('demo Chat adapter rewrite failure');
  }
}

const rawArguments = JSON.stringify({ payload: 'input-'.repeat(1_600) });
const rawToolResult = 'result-'.repeat(3_000);

await runDefaultCompactScenario();
await runCustomAndDisabledScenario();
await runSkillEligibilityScenario();
await runSkillRollbackScenario();

console.log('Chat Context Compact offline suite passed:', {
  scenarios: 4,
  defaultRawInputChars: rawArguments.length,
  defaultRawResultChars: rawToolResult.length,
});

async function runDefaultCompactScenario(): Promise<void> {
  const model = new OfflineChatQueueModel([
    calls(rawCall('default-payload', 'echo-long-payload', rawArguments)),
    (request) => {
      const activeInput = readArguments(request.context, 'default-payload');
      const activeResult = readOutput(request.context, 'default-payload');

      assertDemo(
        activeInput.length <= DEFAULT_TOOL_PAYLOAD_COMPACT_LIMITS.toolInput.targetChars,
        'Default compact must keep active tool input under its target.',
      );
      assertDemo(
        activeResult.length <= DEFAULT_TOOL_PAYLOAD_COMPACT_LIMITS.toolResult.targetChars,
        'Default compact must keep active tool result under its target.',
      );
      assertDemo(
        activeInput !== rawArguments && activeResult !== rawToolResult,
        'Default compact must replace both active payloads.',
      );
      return calls(rawCall('default-end', 'end-agent'));
    },
  ]);
  const agent = new Agent<OpenAIChatProtocol>({ llm: model, contextCompact: {} });

  agent.tools.push({
    name: 'echo-long-payload',
    description: 'Receive a long value and return a long offline result.',
    parameters: z.object({ payload: z.string() }),
    handler(parameters) {
      assertDemo(
        (parameters as { payload: string }).payload === JSON.parse(rawArguments).payload,
        'Tool execution must use the original arguments.',
      );
      return rawToolResult;
    },
  });
  agent.init();
  await agent.agent('Run the default Chat compact scenario.');

  assertDemo(
    readArguments(agent.getHistory(), 'default-payload') === rawArguments,
    'Raw history must retain the original default-compacted arguments.',
  );
  assertDemo(
    readOutput(agent.getHistory(), 'default-payload') === rawToolResult,
    'Raw history must retain the original default-compacted result.',
  );
}

async function runCustomAndDisabledScenario(): Promise<void> {
  const callbackOrder: string[] = [];
  let callbackInFlight = false;
  const originals = {
    first: JSON.stringify({ value: 'first-original' }),
    second: JSON.stringify({ value: 'second-original' }),
  } as const;
  const serialReplacement = async (label: string, replacement: string): Promise<string> => {
    assertDemo(!callbackInFlight, 'Compact callbacks must await the previous callback.');
    callbackInFlight = true;
    callbackOrder.push(label);
    await Promise.resolve();
    callbackInFlight = false;
    return replacement;
  };
  const customInput: ToolPayloadCompactor = (_original, info) =>
    serialReplacement(`input:${info.call.id}`, JSON.stringify({ compacted: info.call.id }));
  const customResult: ToolPayloadCompactor = (_original, info) =>
    serialReplacement(`result:${info.call.id}`, `[result:${info.call.id}]`);
  const model = new OfflineChatQueueModel([
    calls(
      rawCall('custom-first', 'echo', originals.first),
      rawCall('custom-second', 'echo', originals.second),
    ),
    (request) => {
      assertDeepEqual(
        callbackOrder,
        [
          'input:custom-first',
          'result:custom-first',
          'input:custom-second',
          'result:custom-second',
        ],
        'Custom compact callbacks must run serially in call/input/result order.',
      );
      assertDemo(
        readArguments(request.context, 'custom-first') === '{"compacted":"custom-first"}' &&
          readArguments(request.context, 'custom-second') === '{"compacted":"custom-second"}',
        'Every custom input replacement must be visible in active context.',
      );
      assertDemo(
        readOutput(request.context, 'custom-first') === '[result:custom-first]' &&
          readOutput(request.context, 'custom-second') === '[result:custom-second]',
        'Every custom result replacement must be visible in active context.',
      );
      return calls(rawCall('custom-end', 'end-agent'));
    },
  ]);
  const agent = new Agent<OpenAIChatProtocol>({
    llm: model,
    contextCompact: { toolInput: customInput, toolResult: customResult },
  });
  agent.tools.push({
    name: 'echo',
    description: 'Echo the original value.',
    parameters: z.object({ value: z.string() }),
    handler(parameters) {
      return (parameters as { value: string }).value;
    },
  });
  agent.init();
  await agent.agent('Run the custom Chat compact scenario.');

  assertDemo(
    readArguments(agent.getHistory(), 'custom-first') === originals.first &&
      readArguments(agent.getHistory(), 'custom-second') === originals.second &&
      readOutput(agent.getHistory(), 'custom-first') === 'first-original' &&
      readOutput(agent.getHistory(), 'custom-second') === 'second-original',
    'Custom compact must leave raw history unchanged.',
  );

  const inputDisabledModel = new OfflineChatQueueModel([
    calls(rawCall('input-disabled', 'long-echo', rawArguments)),
    (request) => {
      assertDemo(
        readArguments(request.context, 'input-disabled') === rawArguments,
        'toolInput false must preserve active arguments.',
      );
      assertDemo(
        readOutput(request.context, 'input-disabled') !== rawToolResult &&
          readOutput(request.context, 'input-disabled').length <=
            DEFAULT_TOOL_PAYLOAD_COMPACT_LIMITS.toolResult.targetChars,
        'An omitted toolResult must still use the default compactor.',
      );
      return calls(rawCall('input-disabled-end', 'end-agent'));
    },
  ]);
  const inputDisabledAgent = new Agent<OpenAIChatProtocol>({
    llm: inputDisabledModel,
    contextCompact: { toolInput: false },
  });
  inputDisabledAgent.tools.push(longEchoTool());
  inputDisabledAgent.init();
  await inputDisabledAgent.agent('Disable only Chat tool input compact.');
  assertDemo(
    readArguments(inputDisabledAgent.getHistory(), 'input-disabled') === rawArguments &&
      readOutput(inputDisabledAgent.getHistory(), 'input-disabled') === rawToolResult,
    'Input-only disable must retain both original payloads in raw history.',
  );

  const resultDisabledModel = new OfflineChatQueueModel([
    calls(rawCall('result-disabled', 'long-echo', rawArguments)),
    (request) => {
      assertDemo(
        readArguments(request.context, 'result-disabled') !== rawArguments &&
          readArguments(request.context, 'result-disabled').length <=
            DEFAULT_TOOL_PAYLOAD_COMPACT_LIMITS.toolInput.targetChars,
        'An omitted toolInput must still use the default compactor.',
      );
      assertDemo(
        readOutput(request.context, 'result-disabled') === rawToolResult,
        'toolResult false must preserve active output.',
      );
      return calls(rawCall('result-disabled-end', 'end-agent'));
    },
  ]);
  const resultDisabledAgent = new Agent<OpenAIChatProtocol>({
    llm: resultDisabledModel,
    contextCompact: { toolResult: false },
  });
  resultDisabledAgent.tools.push(longEchoTool());
  resultDisabledAgent.init();
  await resultDisabledAgent.agent('Disable only Chat tool result compact.');
  assertDemo(
    readArguments(resultDisabledAgent.getHistory(), 'result-disabled') === rawArguments &&
      readOutput(resultDisabledAgent.getHistory(), 'result-disabled') === rawToolResult,
    'Result-only disable must retain both original payloads in raw history.',
  );

  const disabledArguments = JSON.stringify({ value: 'disabled-original' });
  const disabledModel = new OfflineChatQueueModel([
    calls(rawCall('disabled-call', 'echo-disabled', disabledArguments)),
    (request) => {
      assertDemo(
        readArguments(request.context, 'disabled-call') === disabledArguments &&
          readOutput(request.context, 'disabled-call') === 'disabled-result',
        'Explicit false must preserve both active payloads.',
      );
      return calls(rawCall('disabled-end', 'end-agent'));
    },
  ]);
  const disabledAgent = new Agent<OpenAIChatProtocol>({
    llm: disabledModel,
    contextCompact: { toolInput: false, toolResult: false },
  });
  disabledAgent.tools.push({
    name: 'echo-disabled',
    description: 'Return a stable disabled result.',
    parameters: z.object({ value: z.string() }),
    handler: () => 'disabled-result',
  });
  disabledAgent.init();
  await disabledAgent.agent('Run the disabled Chat compact scenario.');

  const raw = disabledAgent.getHistory();
  const active = disabledAgent.getContext();
  assertDemo(
    raw.length === active.length && raw.every((message, index) => message === active[index]),
    'With both compact kinds disabled, active and raw messages must keep shared identity.',
  );
}

async function runSkillEligibilityScenario(): Promise<void> {
  const skill = inlineSkill();
  const originalSkillArguments = JSON.stringify({
    skill: 'compact-skill',
    args: ' '.repeat(256),
  });
  const compactedSkillArguments = '{"skill":"compact-skill"}';
  const defaultResultCalls: string[] = [];
  const defaultInputCalls: string[] = [];
  const defaultModel = new OfflineChatQueueModel([
    calls(
      rawCall('skill-default', 'skill', originalSkillArguments),
      rawCall('ordinary-default', 'ordinary'),
    ),
    (request) => {
      assertDeepEqual(
        defaultInputCalls,
        ['skill-default', 'ordinary-default'],
        'Skill input must remain eligible for compact.',
      );
      assertDeepEqual(
        defaultResultCalls,
        ['ordinary-default'],
        'Skill result must skip custom compact by default.',
      );
      assertDemo(
        readArguments(request.context, 'skill-default') === compactedSkillArguments,
        'Skill input must support an active copy-on-write replacement.',
      );
      assertDemo(
        readOutput(request.context, 'skill-default').includes('skill-body-'),
        'The default Skill result policy must preserve active output.',
      );
      assertDemo(
        readOutput(request.context, 'ordinary-default') === '[ordinary compacted]',
        'Ordinary tool results must still compact beside a Skill call.',
      );
      return calls(rawCall('skill-default-end', 'end-agent'));
    },
  ]);
  const defaultAgent = new Agent<OpenAIChatProtocol>({
    llm: defaultModel,
    skills: [skill],
    contextCompact: {
      toolInput: (original, info) => {
        defaultInputCalls.push(info.call.id);
        return info.call.name === 'skill' ? compactedSkillArguments : original;
      },
      toolResult: (original, info) => {
        defaultResultCalls.push(info.call.id);
        return info.call.name === 'ordinary' ? '[ordinary compacted]' : original;
      },
    },
  });
  defaultAgent.tools.push({
    name: 'ordinary',
    description: 'Return an ordinary long result.',
    parameters: z.object({}),
    handler: () => `ordinary:${'o'.repeat(1_000)}`,
  });
  defaultAgent.init();
  await defaultAgent.agent('Verify the default Skill compact policy.');

  const rawSkillOutput = readOutput(defaultAgent.getHistory(), 'skill-default');
  assertDemo(
    readArguments(defaultAgent.getHistory(), 'skill-default') === originalSkillArguments &&
      rawSkillOutput.includes('skill-body-') &&
      readOutput(defaultAgent.getContext(), 'skill-default') === rawSkillOutput,
    'Skill input/result rewrites must leave raw history exact and preserve default active output.',
  );

  const optInCalls: string[] = [];
  const optInModel = new OfflineChatQueueModel([
    calls(rawCall('skill-opt-in', 'skill', '{"skill":"compact-skill"}')),
    (request) => {
      assertDeepEqual(
        optInCalls,
        ['skill-opt-in'],
        'Explicit Skill result opt-in must invoke the result compactor once.',
      );
      assertDemo(
        readOutput(request.context, 'skill-opt-in') === '[Skill result compacted]',
        'Explicit Skill result opt-in must rewrite active output.',
      );
      return calls(rawCall('skill-opt-in-end', 'end-agent'));
    },
  ]);
  const optInAgent = new Agent<OpenAIChatProtocol>({
    llm: optInModel,
    skills: [skill],
    skillRuntime: { compactResult: true },
    contextCompact: {
      toolInput: false,
      toolResult: (original, info) => {
        optInCalls.push(info.call.id);
        return info.call.name === 'skill' ? '[Skill result compacted]' : original;
      },
    },
  });
  optInAgent.init();
  await optInAgent.agent('Verify explicit Skill result compact opt-in.');

  assertDemo(
    readOutput(optInAgent.getHistory(), 'skill-opt-in').includes('skill-body-'),
    'Skill opt-in must still retain original output in raw history.',
  );
}

async function runSkillRollbackScenario(): Promise<void> {
  const compactOrder: string[] = [];
  const model = new OfflineChatQueueModel([
    calls(
      rawCall('skill-rollback', 'skill', '{"skill":"compact-skill"}'),
      rawCall('ordinary-rollback', 'rollback-ordinary'),
    ),
  ]);
  const agent = new Agent<OpenAIChatProtocol>({
    llm: model,
    skills: [inlineSkill()],
    skillRuntime: { compactResult: true },
    contextCompact: {
      toolInput: (_original, info) => {
        compactOrder.push(`input:${info.call.id}`);
        return JSON.stringify({ compacted: info.call.id });
      },
      toolResult: (_original, info) => {
        compactOrder.push(`result:${info.call.id}`);
        if (info.call.id === 'ordinary-rollback') {
          throw new Error('demo Skill compactor failure');
        }
        return `[compacted:${info.call.id}]`;
      },
    },
  });
  agent.tools.push({
    name: 'rollback-ordinary',
    description: 'Second call forces a later batch compactor failure.',
    parameters: z.object({}),
    handler: () => 'ordinary rollback raw result',
  });
  agent.init();

  await assertRejects(
    agent.agent('Verify compact transaction rollback.'),
    'demo Skill compactor failure',
  );

  const raw = agent.getHistory();
  const active = agent.getContext();
  assertDemo(
    raw.length === active.length && raw.every((message, index) => message === active[index]),
    'A failing Skill compactor must roll the entire active loop back to raw message identity.',
  );
  assertDemo(
    readOutput(active, 'skill-rollback').includes('skill-body-'),
    'Rollback must preserve the original Skill result.',
  );
  assertDemo(
    readArguments(active, 'skill-rollback') === '{"skill":"compact-skill"}' &&
      readOutput(active, 'ordinary-rollback') === 'ordinary rollback raw result',
    'A later compactor failure must discard every earlier batch replacement.',
  );
  assertDeepEqual(
    compactOrder,
    [
      'input:skill-rollback',
      'result:skill-rollback',
      'input:ordinary-rollback',
      'result:ordinary-rollback',
    ],
    'The rollback fixture must fail only after earlier replacements were proposed.',
  );

  const adapterModel = new FailingRewriteChatModel([
    calls(rawCall('adapter-rollback', 'skill', '{"skill":"compact-skill"}')),
  ]);
  const adapterAgent = new Agent<OpenAIChatProtocol>({
    llm: adapterModel,
    skills: [inlineSkill()],
    skillRuntime: { compactResult: true },
    contextCompact: {
      toolInput: () => '{"skill":"adapter-compacted"}',
      toolResult: () => '[adapter compacted result]',
    },
  });
  adapterAgent.init();
  await assertRejects(
    adapterAgent.agent('Verify adapter failure rollback.'),
    'demo Chat adapter rewrite failure',
  );

  const adapterRaw = adapterAgent.getHistory();
  const adapterActive = adapterAgent.getContext();
  assertDemo(adapterModel.rewriteCalls === 1, 'The adapter rollback fixture must reach rewrite.');
  assertDemo(
    adapterRaw.length === adapterActive.length &&
      adapterRaw.every((message, index) => message === adapterActive[index]),
    'An adapter rewrite failure must leave the entire active loop at raw identity.',
  );
  assertDemo(
    readArguments(adapterActive, 'adapter-rollback') === '{"skill":"compact-skill"}' &&
      readOutput(adapterActive, 'adapter-rollback').includes('skill-body-'),
    'Adapter rollback must preserve both original Skill payloads.',
  );
}

function longEchoTool() {
  return {
    name: 'long-echo',
    description: 'Return the shared long result after receiving the shared long input.',
    parameters: z.object({ payload: z.string() }),
    handler(parameters: unknown) {
      assertDemo(
        (parameters as { payload: string }).payload === JSON.parse(rawArguments).payload,
        'Single-class disable fixtures must execute original arguments.',
      );
      return rawToolResult;
    },
  };
}

function inlineSkill(): AgentSkill {
  return {
    name: 'compact-skill',
    description: 'Offline Skill used to demonstrate compact eligibility.',
    instructions: `skill-body-${'s'.repeat(1_200)}`,
  };
}

function rawCall(id: string, name: string, argumentsText = '{}'): OpenAIChatRawToolCall {
  return {
    id,
    type: 'function',
    function: { name, arguments: argumentsText },
  };
}

function calls(
  ...toolCalls: readonly OpenAIChatRawToolCall[]
): ModelGenerateResult<OpenAIChatProtocol> {
  return {
    messages: [{ role: 'assistant', content: null, tool_calls: toolCalls }],
  };
}

function readArguments(context: readonly OpenAIChatContext[], callId: string): string {
  for (const message of context) {
    if (message.role !== 'assistant') continue;
    const call = message.tool_calls?.find((candidate) => candidate.id === callId);
    if (call?.type === 'function') return call.function.arguments;
  }

  throw new Error(`Expected Chat function arguments for ${callId}.`);
}

function readOutput(context: readonly OpenAIChatContext[], callId: string): string {
  const message = context.find(
    (candidate) => candidate.role === 'tool' && candidate.tool_call_id === callId,
  );
  assertDemo(message?.role === 'tool', `Expected Chat tool output for ${callId}.`);
  assertDemo(
    typeof message.content === 'string',
    `Expected string Chat tool output for ${callId}.`,
  );
  return message.content;
}

async function assertRejects(promise: Promise<unknown>, expectedMessage: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    assertDemo(
      error instanceof Error && error.message.includes(expectedMessage),
      `Expected rejection containing: ${expectedMessage}`,
    );
    return;
  }

  throw new Error(`Expected rejection containing: ${expectedMessage}`);
}

function assertDeepEqual(
  actual: readonly string[],
  expected: readonly string[],
  message: string,
): void {
  assertDemo(JSON.stringify(actual) === JSON.stringify(expected), message);
}

function assertDemo(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
