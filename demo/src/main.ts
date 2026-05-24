/**
 * 离线回归 demo：以确定性的 MockModel 覆盖 Responses 上下文透传、技能提示词、
 * 装饰器工具、子代理调度、事件异常处理和并发调用保护。
 */
import {
  Agent,
  OpenAIChatModel,
  Tool,
  type ModelGenerateRequest,
  type ModelGenerateResult,
  type OpenAIChatProtocol,
  type OpenAIResponsesContext,
  type OpenAIResponsesInputMessage,
  type OpenAIResponsesProtocol,
} from '@manee/agent-framework';
import { z } from 'zod';

import { ResponsesMockModel } from './responses-mock-model';

/** 按固定轮次产生工具调用，并验证提供方 output 字段在下一轮请求中未丢失。 */
class MockModel extends ResponsesMockModel {
  #round = 0;

  async generate(
    request: ModelGenerateRequest<OpenAIResponsesProtocol>,
  ): Promise<ModelGenerateResult<OpenAIResponsesProtocol>> {
    this.#round += 1;

    const systemMessages = request.context.filter(isSystemInputMessage);
    const skillPrompt = systemMessages.find((message) =>
      readInputText(message).includes('get-skill'),
    );
    const getSkillTool = request.tools.find((tool) => tool.name === 'get-skill');
    const saveNoteTool = request.tools.find((tool) => tool.name === 'save-note');
    const runtimeNoteTool = request.tools.find((tool) => tool.name === 'runtime-note');

    assertDemo(Boolean(skillPrompt), 'Expected skill system prompt to be present.');
    assertDemo(
      Boolean(
        readInputText(skillPrompt).includes('demo-skill') &&
        readInputText(skillPrompt).includes('runtime-skill'),
      ),
      'Expected skill system prompt to include current skills.',
    );
    assertDemo(
      getSkillTool?.description === '获取指定下标的技能手册完整内容。',
      'Expected get-skill description to stay static.',
    );
    assertDemo(
      saveNoteTool !== undefined && !('strict' in saveNoteTool),
      'Expected an unspecified Responses strict option to be omitted.',
    );
    assertDemo(
      runtimeNoteTool?.strict === false,
      'Expected an explicitly disabled Responses strict option to be preserved.',
    );

    console.log(
      `round ${this.#round}: ${systemMessages.length} system prompt(s), ${request.tools.length} tool(s)`,
    );

    if (this.#round === 2) {
      assertDemo(
        hasPreservedFunctionCall(request.context, 'call_get_skill'),
        'Expected model output fields to be preserved in the next Responses input.',
      );
      assertDemo(
        hasPreservedReasoning(request.context, 'call_get_skill'),
        'Expected declared Responses reasoning fields to be preserved.',
      );
    }

    if (this.#round === 3) {
      assertDemo(
        hasPreservedFunctionCall(request.context, 'call_save_note'),
        'Expected later model output fields to be preserved in Responses input.',
      );
    }

    if (this.#round === 1) {
      return toolResponse('call_get_skill', 'get-skill', { index: 0 });
    }

    if (this.#round === 2) {
      return toolResponse('call_save_note', 'save-note', { note: 'demo note' });
    }

    return toolResponse('call_end_agent', 'end-agent', {});
  }
}

/** 用 private 装饰器工具验证实例注册以及 before-cancel 工具结果写入。 */
class DemoAgent extends Agent<OpenAIResponsesProtocol> {
  @Tool({
    name: 'save-note',
    description: 'Save a note for the current demo task.',
    parameters: z.object({
      note: z.string(),
    }),
  })
  #saveNote(parameters: unknown): string {
    const { note } = parameters as { note: string };
    return `saved:${note}`;
  }
}

/** 分别驱动父代理与 worker 子代理的离线模型，用于覆盖 agent-result 汇报流程。 */
class SubAgentDemoModel extends ResponsesMockModel {
  #parentRound = 0;
  #workerRound = 0;

  async generate(
    request: ModelGenerateRequest<OpenAIResponsesProtocol>,
  ): Promise<ModelGenerateResult<OpenAIResponsesProtocol>> {
    const toolNames = request.tools.map((tool) => tool.name);

    if (toolNames.includes('agent-result')) {
      this.#workerRound += 1;
      console.log(`worker round ${this.#workerRound}: tools=${toolNames.join(',')}`);

      if (this.#workerRound === 1) {
        return toolResponse('call_worker_echo', 'worker-echo', {
          task: 'prepare sub-agent report',
        });
      }

      if (this.#workerRound === 2) {
        return toolResponse('call_agent_result', 'agent-result', {
          result: 'worker report ready',
        });
      }

      return toolResponse('call_worker_end', 'end-agent', {});
    }

    this.#parentRound += 1;
    console.log(`parent round ${this.#parentRound}: tools=${toolNames.join(',')}`);

    if (this.#parentRound === 1) {
      return toolResponse('call_dispatch_agent', 'agent', {
        agentName: 'worker',
        input: 'Ask the worker agent to prepare a short report.',
        outputDescription: 'A short report string for the parent agent.',
      });
    }

    return toolResponse('call_parent_end', 'end-agent', {});
  }
}

/** 暂停首个请求，以稳定复现并发触发第二次 `agent()` 的场景。 */
class ConcurrentDemoModel extends ResponsesMockModel {
  #markStarted: (() => void) | undefined;
  #release: (() => void) | undefined;
  readonly started: Promise<void>;

  constructor() {
    super();
    this.started = new Promise((resolve) => {
      this.#markStarted = resolve;
    });
  }

  async generate(): Promise<ModelGenerateResult<OpenAIResponsesProtocol>> {
    this.#markStarted?.();

    await new Promise<void>((resolve) => {
      this.#release = resolve;
    });

    return toolResponse('call_concurrent_end', 'end-agent', {});
  }

  release(): void {
    this.#release?.();
  }
}

/** 使用 Chat wire structure 验证多工具展开、上下文回传与 tool role 结果解析。 */
class ChatDemoModel extends OpenAIChatModel {
  #round = 0;

  constructor() {
    super({
      apiKey: 'offline-chat-mock-key',
      model: 'offline-chat-mock-model',
    });
  }

  override async generate(
    request: ModelGenerateRequest<OpenAIChatProtocol>,
  ): Promise<ModelGenerateResult<OpenAIChatProtocol>> {
    this.#round += 1;

    if (this.#round === 1) {
      assertDemo(
        request.tools.some(
          (tool) => tool.function.name === 'chat-record' && tool.function.strict === true,
        ),
        'Expected Chat model to receive an explicitly strict function tool.',
      );

      return {
        messages: [
          {
            role: 'assistant',
            content: null,
            refusal: null,
            annotations: [
              {
                type: 'url_citation',
                url_citation: {
                  start_index: 0,
                  end_index: 4,
                  title: 'Demo citation',
                  url: 'https://example.com/chat-citation',
                },
              },
            ],
            tool_calls: [
              {
                id: 'chat_call_first',
                type: 'function',
                function: { name: 'chat-record', arguments: '{"value":"first"}' },
              },
              {
                id: 'chat_call_second',
                type: 'function',
                function: { name: 'chat-record', arguments: '{"value":"second"}' },
              },
            ],
          },
        ],
      };
    }

    const results = this.parseToolCallOutputMessages(request.context);

    assertDemo(results.length === 2, 'Expected both Chat tool results in the next request.');
    assertDemo(
      results.map((result) => result.message.output).join(',') === 'recorded:first,recorded:second',
      'Expected Chat tools to execute in source order.',
    );
    assertDemo(
      request.context.some(
        (message) =>
          message.role === 'assistant' &&
          message.annotations?.[0]?.url_citation.title === 'Demo citation',
      ),
      'Expected declared Chat assistant response fields to be passed through.',
    );

    return {
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'chat_call_end',
              type: 'function',
              function: { name: 'end-agent', arguments: '{}' },
            },
          ],
        },
      ],
    };
  }
}

class EmptyChatDemoModel extends OpenAIChatModel {
  calls = 0;

  constructor() {
    super({
      apiKey: 'offline-chat-mock-key',
      model: 'offline-chat-mock-model',
    });
  }

  override async generate(): Promise<ModelGenerateResult<OpenAIChatProtocol>> {
    this.calls += 1;
    return { messages: [] };
  }
}

class ChatDemoAgent extends Agent<OpenAIChatProtocol> {
  @Tool({
    name: 'chat-record',
    description: 'Record a Chat protocol tool execution.',
    parameters: z.object({
      value: z.string(),
    }),
    strict: true,
  })
  #chatRecord(parameters: unknown): string {
    const { value } = parameters as { value: string };

    return `recorded:${value}`;
  }
}

/** 供内置 `agent` 工具调度的最小子代理。 */
class WorkerAgent extends Agent<OpenAIResponsesProtocol> {
  static name = 'worker';
  static description = 'A small worker agent used by the local sub-agent demo.';

  @Tool({
    name: 'worker-echo',
    description: 'Echo the worker task so the demo can verify private tool execution.',
    parameters: z.object({
      task: z.string(),
    }),
  })
  #workerEcho(parameters: unknown): string {
    const { task } = parameters as { task: string };
    return `worker accepted:${task}`;
  }
}

// 先恢复一段包含响应元数据的历史，后续轮次会验证其透传行为。
const restoredHistory: OpenAIResponsesContext[] = [
  {
    role: 'user',
    content: [{ type: 'input_text', text: 'Previous demo request.' }],
  },
  {
    type: 'message',
    id: 'msg_previous',
    role: 'assistant',
    status: 'completed',
    phase: 'final_answer',
    content: [{ type: 'output_text', text: 'Previous demo response.', annotations: [] }],
  },
];

const agent = new DemoAgent({
  llm: new MockModel(),
  initContext: restoredHistory,
  systemPrompts: ['You are running the local demo.'],
  skills: [
    {
      name: 'demo-skill',
      description: 'A sample skill used by the demo model.',
      systemContent: 'Prefer concise tool use.',
      sops: [
        {
          description: 'Handle demo notes',
          content: 'Read the note request, save it, then finish the task.',
        },
      ],
    },
  ],
});

agent.tools.push({
  name: 'runtime-note',
  description: 'Runtime-only tool pushed directly into the public tools array.',
  strict: false,
  handler: () => 'runtime note ready',
});

// 初始化失败和未初始化调用分别覆盖配置校验与生命周期入口保护。
try {
  const invalidAgent = new Agent({
    llm: new MockModel(),
    subAgents: [WorkerAgent, WorkerAgent],
  });

  invalidAgent.init();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.log(`expected init error: ${message}`);
}

const uninitializedAgent = new Agent({
  llm: new MockModel(),
});

uninitializedAgent.onAgentError((error) => {
  console.log(`expected uninitialized agent error event: ${error.message}`);
});

try {
  await uninitializedAgent.agent('This should fail before initialization.');
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.log(`expected uninitialized agent error: ${message}`);
}

try {
  await uninitializedAgent.toolCall({
    id: 'call_uninitialized',
    name: 'missing',
    arguments: '{}',
    sourceMessage: {
      type: 'function_call',
      call_id: 'call_uninitialized',
      name: 'missing',
      arguments: '{}',
    },
    sourceCall: {
      type: 'function_call',
      call_id: 'call_uninitialized',
      name: 'missing',
      arguments: '{}',
    },
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.log(`expected uninitialized toolCall error: ${message}`);
}

console.log(`base static tools=${Agent.toolsDefinition.map((tool) => tool.name).join(',')}`);
console.log(`demo static tools=${DemoAgent.toolsDefinition.map((tool) => tool.name).join(',')}`);
console.log(
  `worker static tools=${WorkerAgent.toolsDefinition.map((tool) => tool.name).join(',')}`,
);
console.log(`runtime tool visible=${agent.tools.some((tool) => tool.name === 'runtime-note')}`);
console.log(`restored context messages=${agent.getContext().length}`);
restoredHistory.push({
  role: 'user',
  content: [{ type: 'input_text', text: 'This external mutation should not affect the agent.' }],
});
console.log(`restored context after external mutation=${agent.getContext().length}`);

const outputParserModel = new MockModel();
const contentArrayToolOutputs = outputParserModel.parseToolCallOutputMessages([
  {
    type: 'function_call_output',
    call_id: 'call_content_array_output',
    output: [{ type: 'input_text', text: 'tool output content item' }],
  },
]);

assertDemo(
  contentArrayToolOutputs.length === 1 &&
    Array.isArray(contentArrayToolOutputs[0]?.message.output) &&
    contentArrayToolOutputs[0]?.message.output[0]?.type === 'input_text',
  'Expected Responses parser to preserve array function_call_output content.',
);
console.log('Responses function_call_output array parser demo ready.');

agent.addSystemPrompts('Keep tool calls minimal.');
agent.addSkill({
  name: 'runtime-skill',
  description: 'Added after construction to verify dynamic skill descriptions.',
});

// 事件组合覆盖写入顺序、before 取消工具和工具错误观察能力。
agent.onModelResponse((output) => {
  assertDemo(
    output.every((item) => !agent.getContext().includes(item)),
    'Expected onModelResponse before output items are appended.',
  );
  console.log(
    `model response: ${output.map((item) => ('type' in item ? item.type : item.role)).join(',')}`,
  );
});

agent.onAfterToolCall(
  'get-skill',
  (_parameters, _message, result) => {
    console.log(`get-skill result length: ${String(result).length}`);
  },
  {
    await: true,
  },
);

agent.onBeforeToolCall(
  'save-note',
  () => {
    throw new Error('demo before hook failed');
  },
  {
    await: true,
    errorCancel: true,
  },
);

agent.onToolCallError((name, triggerType, error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.log(`tool error: ${name}/${triggerType}/${message}`);
});

agent.onAgentStatusChanged('ended', (rawContext, context) => {
  console.log(`agent ended: raw=${rawContext.length}, context=${context.length}`);
});

agent.init();

const finalContext = await agent.agent('Run the demo task.');

console.log(`Demo ready: final context messages=${finalContext.length}`);

// 独立执行子代理调度流程，避免与主场景的上下文互相影响。
const subAgentDemo = new Agent({
  llm: new SubAgentDemoModel(),
  subAgents: [WorkerAgent],
  maxIterations: 6,
});

subAgentDemo.init();

const subAgentContext = await subAgentDemo.agent('Run the sub-agent demo task.');

console.log(`Sub-agent demo ready: final context messages=${subAgentContext.length}`);

// 第二次并发调用应被拒绝，但不得把仍在执行的首次任务标记为失败。
const concurrentModel = new ConcurrentDemoModel();
const concurrentAgent = new Agent({
  llm: concurrentModel,
});
let concurrentAgentErrors = 0;
let concurrentFailedStatuses = 0;
let concurrentEndedStatuses = 0;

concurrentAgent.onAgentError((error) => {
  concurrentAgentErrors += 1;
  console.log(`expected concurrent agent error event: ${error.message}`);
});
concurrentAgent.onAgentStatusChanged('failed', () => {
  concurrentFailedStatuses += 1;
});
concurrentAgent.onAgentStatusChanged('ended', () => {
  concurrentEndedStatuses += 1;
});

concurrentAgent.init();

const firstConcurrentRun = concurrentAgent.agent('Run the first concurrent task.');

await concurrentModel.started;

let concurrentErrorMessage = '';

try {
  await concurrentAgent.agent('Run the second concurrent task.');
} catch (error) {
  concurrentErrorMessage = error instanceof Error ? error.message : String(error);
  console.log(`expected concurrent agent error: ${concurrentErrorMessage}`);
}

assertDemo(
  concurrentErrorMessage === 'Agent is already running.',
  'Expected concurrent agent call to be rejected.',
);
assertDemo(concurrentAgentErrors === 1, 'Expected concurrent agent error event once.');
assertDemo(
  concurrentFailedStatuses === 0,
  'Expected concurrent call not to trigger failed status.',
);

concurrentModel.release();

const concurrentContext = await firstConcurrentRun;

assertDemo(concurrentEndedStatuses === 1, 'Expected first concurrent agent run to end.');

console.log(`Concurrent demo ready: final context messages=${concurrentContext.length}`);

// Chat 协议使用同一个 Agent 编排器，且能把同一 assistant 消息中的多个调用顺序展开。
const chatAgent = new ChatDemoAgent({
  llm: new ChatDemoModel(),
});

chatAgent.init();

const chatContext = await chatAgent.agent('Run the Chat protocol demo.');
const chatToolResults = chatContext.filter((message) => message.role === 'tool');

assertDemo(chatToolResults.length === 3, 'Expected two Chat tool results plus end-agent result.');
console.log(`Chat demo ready: final context messages=${chatContext.length}`);

const emptyChatModel = new EmptyChatDemoModel();
const emptyChatAgent = new Agent<OpenAIChatProtocol>({
  llm: emptyChatModel,
});
let emptyChatError = '';

emptyChatAgent.init();

try {
  await emptyChatAgent.agent('Return no Chat choices.');
} catch (error) {
  emptyChatError = error instanceof Error ? error.message : String(error);
}

assertDemo(
  emptyChatError === 'Model returned no messages after 4 attempt(s).',
  'Expected empty Chat responses to fail after three retries.',
);
assertDemo(emptyChatModel.calls === 4, 'Expected one Chat request plus three retries.');
console.log('Chat empty-response retry demo ready.');

function toolResponse(
  id: string,
  name: string,
  parameters: unknown,
): ModelGenerateResult<OpenAIResponsesProtocol> {
  return {
    messages: [
      {
        type: 'reasoning',
        id: `rs_${id}`,
        status: 'completed',
        summary: [{ type: 'summary_text', text: `considering ${name}` }],
        encrypted_content: `encrypted:${id}`,
      },
      {
        type: 'function_call',
        id: `fc_${id}`,
        call_id: id,
        name,
        arguments: JSON.stringify(parameters),
        status: 'completed',
      },
    ],
  };
}

function hasPreservedFunctionCall(
  input: readonly OpenAIResponsesContext[],
  callId: string,
): boolean {
  return input.some(
    (item) =>
      item.type === 'function_call' &&
      'call_id' in item &&
      item.call_id === callId &&
      item.status === 'completed' &&
      item.id === `fc_${callId}`,
  );
}

function hasPreservedReasoning(input: readonly OpenAIResponsesContext[], callId: string): boolean {
  return input.some(
    (item) =>
      item.type === 'reasoning' &&
      item.id === `rs_${callId}` &&
      item.status === 'completed' &&
      item.encrypted_content === `encrypted:${callId}`,
  );
}

function isSystemInputMessage(
  message: OpenAIResponsesContext,
): message is OpenAIResponsesInputMessage {
  return 'role' in message && message.role === 'system';
}

function readInputText(message: OpenAIResponsesInputMessage | undefined): string {
  if (!message) {
    return '';
  }

  if (typeof message.content === 'string') {
    return message.content;
  }

  return message.content
    .filter((part) => part.type === 'input_text')
    .map((part) => part.text)
    .join('\n');
}

function assertDemo(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}
