import {
  Agent,
  Model,
  Tool,
  type AgentContext,
  type ModelChatRequest,
  type ModelChatResponse,
} from '@manee/agent-framework';
import { z } from 'zod';

class MockModel extends Model {
  #round = 0;

  async chat(request: ModelChatRequest): Promise<ModelChatResponse> {
    this.#round += 1;

    const systemMessages = request.messages.filter((message) => message.role === 'system');
    const skillPrompt = systemMessages.find((message) => message.content.includes('框架技能约束'));
    const getSkillTool = request.tools.find((tool) => tool.function.name === 'get-skill');

    assertDemo(Boolean(skillPrompt), 'Expected skill system prompt to be present.');
    assertDemo(
      Boolean(
        skillPrompt?.content.includes('demo-skill') &&
        skillPrompt.content.includes('runtime-skill'),
      ),
      'Expected skill system prompt to include current skills.',
    );
    assertDemo(
      getSkillTool?.function.description === '获取指定下标的技能手册完整内容。',
      'Expected get-skill description to stay static.',
    );

    console.log(
      `round ${this.#round}: ${systemMessages.length} system prompt(s), ${request.tools.length} tool(s)`,
    );

    if (this.#round === 1) {
      return {
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              toolCalls: [
                {
                  id: 'call_get_skill',
                  name: 'get-skill',
                  arguments: JSON.stringify({
                    index: 0,
                  }),
                },
              ],
            },
            finishReason: 'tool_calls',
          },
        ],
      };
    }

    if (this.#round === 2) {
      return {
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              toolCalls: [
                {
                  id: 'call_save_note',
                  name: 'save-note',
                  arguments: JSON.stringify({
                    note: 'demo note',
                  }),
                },
              ],
            },
            finishReason: 'tool_calls',
          },
        ],
      };
    }

    return {
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            toolCalls: [
              {
                id: 'call_end_agent',
                name: 'end-agent',
                arguments: '{}',
              },
            ],
          },
          finishReason: 'tool_calls',
        },
      ],
    };
  }
}

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

class SubAgentDemoModel extends Model {
  #parentRound = 0;
  #workerRound = 0;

  async chat(request: ModelChatRequest): Promise<ModelChatResponse> {
    const toolNames = request.tools.map((tool) => tool.function.name);

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

  async chat(): Promise<ModelChatResponse> {
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

const restoredHistory: AgentContext[] = [
  {
    role: 'user',
    content: 'Previous demo request.',
  },
  {
    role: 'assistant',
    content: 'Previous demo response.',
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
  content: 'This external mutation should not affect the agent.',
});
console.log(`restored context after external mutation=${agent.getContext().length}`);

agent.addSystemPrompts('Keep tool calls minimal.');
agent.addSkill({
  name: 'runtime-skill',
  description: 'Added after construction to verify dynamic skill descriptions.',
});

agent.onModelResponse((message) => {
  console.log(`model response: ${message.role}`);
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

const subAgentDemo = new Agent({
  llm: new SubAgentDemoModel(),
  subAgents: [WorkerAgent],
  maxIterations: 6,
});

subAgentDemo.init();

const subAgentContext = await subAgentDemo.agent('Run the sub-agent demo task.');

console.log(`Sub-agent demo ready: final context messages=${subAgentContext.length}`);

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

function toolResponse(id: string, name: string, parameters: unknown): ModelChatResponse {
  return {
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          toolCalls: [
            {
              id,
              name,
              arguments: JSON.stringify(parameters),
            },
          ],
        },
        finishReason: 'tool_calls',
      },
    ],
  };
}

function assertDemo(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}
