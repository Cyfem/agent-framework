/**
 * 离线回归 demo：以确定性的 MockModel 覆盖 Responses 上下文透传、技能提示词、
 * 装饰器工具、子代理调度、事件异常处理和并发调用保护。
 */
import {
  Agent,
  Model,
  Tool,
  type AgentContext,
  type AgentInputMessage,
  type ModelResponsesRequest,
  type ModelResponsesResponse,
} from '@manee/agent-framework';
import { z } from 'zod';

/** 按固定轮次产生工具调用，并验证提供方 output 字段在下一轮请求中未丢失。 */
class MockModel extends Model {
  #round = 0;

  async responses(request: ModelResponsesRequest): Promise<ModelResponsesResponse> {
    this.#round += 1;

    const systemMessages = request.input.filter(isSystemInputMessage);
    const skillPrompt = systemMessages.find((message) =>
      readInputText(message).includes('get-skill'),
    );
    const getSkillTool = request.tools.find((tool) => tool.name === 'get-skill');

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

    console.log(
      `round ${this.#round}: ${systemMessages.length} system prompt(s), ${request.tools.length} tool(s)`,
    );

    if (this.#round === 2) {
      assertDemo(
        hasPreservedFunctionCall(request.input, 'call_get_skill'),
        'Expected model output fields to be preserved in the next Responses input.',
      );
    }

    if (this.#round === 3) {
      assertDemo(
        hasPreservedFunctionCall(request.input, 'call_save_note'),
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
class DemoAgent extends Agent {
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
class SubAgentDemoModel extends Model {
  #parentRound = 0;
  #workerRound = 0;

  async responses(request: ModelResponsesRequest): Promise<ModelResponsesResponse> {
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
class ConcurrentDemoModel extends Model {
  #markStarted: (() => void) | undefined;
  #release: (() => void) | undefined;
  readonly started: Promise<void>;

  constructor() {
    super();
    this.started = new Promise((resolve) => {
      this.#markStarted = resolve;
    });
  }

  async responses(): Promise<ModelResponsesResponse> {
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

/** 供内置 `agent` 工具调度的最小子代理。 */
class WorkerAgent extends Agent {
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
const restoredHistory: AgentContext[] = [
  {
    role: 'user',
    content: [{ type: 'input_text', text: 'Previous demo request.' }],
  },
  {
    type: 'message',
    id: 'msg_previous',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: 'Previous demo response.' }],
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
    type: 'function_call',
    call_id: 'call_uninitialized',
    name: 'missing',
    arguments: '{}',
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
  console.log(`model response: ${output.map((item) => item.type).join(',')}`);
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

function toolResponse(id: string, name: string, parameters: unknown): ModelResponsesResponse {
  return {
    output: [
      {
        type: 'reasoning',
        id: `rs_${id}`,
        status: 'completed',
        summary: [{ type: 'summary_text', text: `considering ${name}` }],
        providerMarker: `reasoning:${id}`,
      },
      {
        type: 'function_call',
        id: `fc_${id}`,
        call_id: id,
        name,
        arguments: JSON.stringify(parameters),
        status: 'completed',
        providerMarker: `preserved:${id}`,
      },
    ],
  };
}

function hasPreservedFunctionCall(input: readonly AgentContext[], callId: string): boolean {
  return input.some(
    (item) =>
      item.type === 'function_call' &&
      'call_id' in item &&
      item.call_id === callId &&
      'status' in item &&
      item.status === 'completed' &&
      'providerMarker' in item &&
      item.providerMarker === `preserved:${callId}`,
  );
}

function isSystemInputMessage(message: AgentContext): message is AgentInputMessage {
  return 'role' in message && message.role === 'system';
}

function readInputText(message: AgentInputMessage | undefined): string {
  if (!message) {
    return '';
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
