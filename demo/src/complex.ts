/**
 * 方舟完整能力 demo：在真实 Responses 对话中组合动态工具描述、运行时工具、
 * 恢复历史、子代理以及 before/calling/after 错误事件路径。
 */
import {
  Agent,
  OpenAIModel,
  Tool,
  type AgentContext,
  type AgentResponseOutputItem,
} from '@manee/agent-framework';
import { z } from 'zod';

type Priority = 'low' | 'medium' | 'high';

interface Ticket {
  id: string;
  title: string;
  priority: Priority;
  tags: string[];
  notes: string[];
  estimate?: {
    points: number;
    confidence: number;
  };
}

const defaultArkBaseURL = 'https://ark.cn-beijing.volces.com/api/v3';
const defaultArkModel = 'doubao-seed-2-0-pro-260215';

let memoryDescriptionBuilds = 0;

/** 由父代理调度的质量复核子代理，用于验证 `agent-result` 汇报协议。 */
class QualityReviewAgent extends Agent {
  static name = 'quality-reviewer';
  static description = 'Reviews the parent agent demo state and returns a concise quality summary.';

  @Tool({
    name: 'review-checklist',
    description:
      'Review a demo artifact against a short checklist and return a compact pass/fail summary.',
    parameters: z.object({
      artifact: z.string().min(1),
      checklist: z.array(z.string().min(1)).min(1),
    }),
  })
  #reviewChecklist(parameters: unknown): Record<string, unknown> {
    const { artifact, checklist } = parameters as {
      artifact: string;
      checklist: string[];
    };

    return {
      artifact,
      checked: checklist,
      passed: true,
      summary: `reviewed ${artifact} with ${checklist.length} checklist item(s)`,
    };
  }
}

/** 以内存工单为业务载体，集中暴露框架主要能力的父代理。 */
class ArkComplexDemoAgent extends Agent {
  #nextTicketId = 1;
  #tickets = new Map<string, Ticket>();

  @Tool({
    name: 'create-ticket',
    description:
      'Create an in-memory work item for this Ark Coding Plan integration demo. The first ticket id will be T-1.',
    parameters: z.object({
      title: z.string().min(3),
      priority: z.enum(['low', 'medium', 'high']),
      tags: z.array(z.string().min(1)).default([]),
    }),
  })
  #createTicket(parameters: unknown): Ticket {
    const { title, priority, tags } = parameters as {
      title: string;
      priority: Priority;
      tags: string[];
    };
    const ticket: Ticket = {
      id: `T-${this.#nextTicketId}`,
      title,
      priority,
      tags,
      notes: [],
    };

    this.#nextTicketId += 1;
    this.#tickets.set(ticket.id, ticket);

    return ticket;
  }

  @Tool({
    name: 'append-ticket-note',
    description:
      'Append a note to an existing in-memory ticket. Use ticketId T-1 after create-ticket returns.',
    parameters: z.object({
      ticketId: z.string().min(1),
      note: z.string().min(1),
    }),
  })
  #appendTicketNote(parameters: unknown): Ticket | string {
    const { ticketId, note } = parameters as {
      ticketId: string;
      note: string;
    };
    const ticket = this.#tickets.get(ticketId);

    if (!ticket) {
      return `Ticket ${ticketId} was not found.`;
    }

    ticket.notes.push(note);
    return ticket;
  }

  @Tool({
    name: 'estimate-effort',
    description: 'Attach a lightweight effort estimate to an existing ticket.',
    parameters: z.object({
      ticketId: z.string().min(1),
      points: z.number().int().positive(),
      confidence: z.number().min(0).max(1),
    }),
  })
  #estimateEffort(parameters: unknown): Ticket | string {
    const { ticketId, points, confidence } = parameters as {
      ticketId: string;
      points: number;
      confidence: number;
    };
    const ticket = this.#tickets.get(ticketId);

    if (!ticket) {
      return `Ticket ${ticketId} was not found.`;
    }

    ticket.estimate = {
      points,
      confidence,
    };

    return ticket;
  }

  @Tool({
    name: 'search-memory',
    description: ({ context, history, skills, systemPrompts }) => {
      memoryDescriptionBuilds += 1;

      return [
        'Search the demo memory for framework facts.',
        `descriptionBuild=${memoryDescriptionBuilds}`,
        `skills=${skills.length}`,
        `context=${context.length}`,
        `history=${history.length}`,
        `systemPrompts=${systemPrompts.length}`,
      ].join(' | ');
    },
    parameters: z.object({
      query: z.string().min(1),
      limit: z.number().int().positive().max(5).default(3),
    }),
  })
  #searchMemory(parameters: unknown): string[] {
    const { query, limit } = parameters as {
      query: string;
      limit: number;
    };
    const facts = [
      'System prompts are prepended only for model calls.',
      'Tool descriptions can be functions and are rebuilt for every model request.',
      'Tool failures are converted into tool messages for the model.',
      'Before hooks can cancel a tool call before implementation runs.',
      'After hook errors are reported and ignored.',
      'The agent only ends when end-agent changes the status to ended.',
    ];

    return facts.filter((fact) => fact.toLowerCase().includes(query.toLowerCase())).slice(0, limit);
  }

  @Tool({
    name: 'summarize-board',
    description: 'Return a compact summary of all in-memory tickets.',
  })
  #summarizeBoard(): Record<string, unknown> {
    const tickets = [...this.#tickets.values()];

    return {
      total: tickets.length,
      ids: tickets.map((ticket) => ticket.id),
      estimated: tickets.filter((ticket) => ticket.estimate).length,
      notes: tickets.reduce((count, ticket) => count + ticket.notes.length, 0),
    };
  }

  @Tool({
    name: 'read-project-config',
    description:
      'Return static configuration values for this demo. This tool intentionally has no parameters.',
  })
  #readProjectConfig(): Record<string, unknown> {
    return {
      runtime: 'node',
      provider: 'ark-coding-plan',
      expectedModel: defaultArkModel,
      toolsAreDecorated: true,
    };
  }

  @Tool({
    name: 'risky-operation',
    description:
      'A dangerous demo operation. Call it once with operation="delete-demo-state"; the before hook will cancel it.',
    parameters: z.object({
      operation: z.string().min(1),
    }),
  })
  #riskyOperation(): string {
    return 'This should never be returned when errorCancel is working.';
  }

  @Tool({
    name: 'unstable-tool',
    description:
      'Always throws to demonstrate calling-stage tool errors. Call it once with a short reason.',
    parameters: z.object({
      reason: z.string().min(1),
    }),
  })
  #unstableTool(parameters: unknown): string {
    const { reason } = parameters as {
      reason: string;
    };

    throw new Error(`unstable-tool failed: ${reason}`);
  }
}

const apiKey = process.env.ARK_API_KEY;

if (!apiKey) {
  console.error('Missing ARK_API_KEY. Run this demo with an Ark Coding Plan API key.');
  process.exitCode = 1;
} else {
  await runArkComplexDemo(apiKey);
}

/** 组装真实方舟场景，并通过日志呈现每一条功能覆盖路径。 */
async function runArkComplexDemo(apiKey: string): Promise<void> {
  const baseURL = process.env.ARK_BASE_URL ?? defaultArkBaseURL;
  const modelName = process.env.ARK_MODEL ?? defaultArkModel;
  const toolErrors: string[] = [];
  const modelResponses: string[] = [];
  const calledTools = new Set<string>();
  let runtimeInjectionDone = false;
  let unsubscribedModelResponses = 0;
  let runtimeStateReportCalls = 0;
  const restoredContext: AgentContext[] = [
    {
      role: 'user',
      content: [{ type: 'input_text', text: 'Previous Ark demo warm-up request.' }],
    },
    {
      type: 'message',
      id: 'msg_previous',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Previous Ark demo warm-up response.' }],
    },
  ];
  const restoredHistory: AgentContext[] = [
    ...restoredContext,
    {
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: 'Raw history can include messages outside the active context.',
        },
      ],
    },
  ];

  const agent = new ArkComplexDemoAgent({
    llm: new OpenAIModel({
      apiKey,
      baseURL,
      model: modelName,
    }),
    initContext: restoredContext,
    initRawContext: restoredHistory,
    subAgents: [QualityReviewAgent],
    systemPrompts: [
      'You are running an automated integration demo for a Node.js agent framework through Ark Coding Plan.',
      [
        'Use tools to exercise framework features. Follow this order as closely as possible:',
        '1. call get-skill with index 0.',
        '2. call read-project-config.',
        '3. call create-ticket for a high-priority demo ticket.',
        '4. call append-ticket-note with ticketId "T-1".',
        '5. call estimate-effort with ticketId "T-1", points 3, confidence 0.8.',
        '6. call search-memory with query "tool" and limit 3.',
        '7. call summarize-board.',
        '8. call runtime-state-report.',
        '9. call agent with agentName "quality-reviewer", input asking it to review ticket T-1 and the framework demo coverage, and outputDescription "A concise quality review summary string."',
        '10. call risky-operation with operation "delete-demo-state"; this is expected to be canceled.',
        '11. call unstable-tool with reason "intentional calling-stage failure"; this is expected to fail.',
        '12. call summarize-board again.',
        '13. after all tool results have been observed, call end-agent by itself.',
      ].join('\n'),
      'Do not ask follow-up questions. Do not finish with natural language only.',
    ],
    skills: [
      {
        name: 'ark-complex-demo-playbook',
        description: 'A playbook for exercising tool calls, events, dynamic skills, and errors.',
        systemContent:
          'Prefer concrete tool calls over prose. Recover from expected tool errors and continue the scenario.',
        sops: [
          {
            description: 'Feature coverage flow',
            content:
              'Inspect the skill, create and update a ticket, search memory, summarize state, trigger expected errors, then end.',
          },
        ],
      },
    ],
  });

  // 运行时追加的工具必须在 `init()` 前完成，以纳入同一轮配置校验。
  agent.tools.push({
    name: 'runtime-state-report',
    description:
      'Runtime-only tool pushed directly into agent.tools before init. It reports context, history, and static tool metadata.',
    handler: () => {
      runtimeStateReportCalls += 1;

      return {
        contextMessages: agent.getContext().length,
        historyMessages: agent.getHistory().length,
        staticTools: ArkComplexDemoAgent.toolsDefinition.map((tool) => tool.name),
        subAgentStaticTools: QualityReviewAgent.toolsDefinition.map((tool) => tool.name),
      };
    },
  });

  agent.addSystemPrompts('This system prompt was added before the first Ark model request.');
  agent.addSkill({
    name: 'runtime-skill-before-run',
    description: 'Added before the first model request and visible in the skill system prompt.',
  });

  const unsubscribeModelResponse = agent.onModelResponse(() => {
    unsubscribedModelResponses += 1;
  });
  unsubscribeModelResponse();

  // 首轮响应后注入提示词与技能，验证下一次请求即可读取动态变更。
  agent.onModelResponse((output) => {
    const summary = summarizeOutput(output);

    modelResponses.push(summary);
    console.log(`model response before append: ${summary}`);

    if (!runtimeInjectionDone) {
      runtimeInjectionDone = true;
      agent.addSystemPrompts('This prompt was added while the Ark demo was running.');
      agent.addSkill({
        name: 'runtime-skill-during-run',
        description: 'Added from onModelResponse and visible from the next model request.',
      });
    }
  });

  agent.onAgentStatusChanged('running', (rawContext, context) => {
    console.log(`status running: raw=${rawContext.length}, context=${context.length}`);
  });

  agent.onAgentStatusChanged('ended', (rawContext, context) => {
    console.log(`status ended: raw=${rawContext.length}, context=${context.length}`);
  });

  agent.onAgentStatusChanged('failed', (rawContext, context) => {
    console.log(`status failed: raw=${rawContext.length}, context=${context.length}`);
  });

  for (const toolName of [
    'get-skill',
    'read-project-config',
    'create-ticket',
    'append-ticket-note',
    'estimate-effort',
    'search-memory',
    'summarize-board',
    'runtime-state-report',
    'agent',
    'risky-operation',
    'unstable-tool',
    'end-agent',
  ]) {
    agent.onBeforeToolCall(
      toolName,
      () => {
        calledTools.add(toolName);
      },
      {
        await: true,
      },
    );
  }

  // 三类 hook 分别展示 await-before、非阻塞 rejection 与显式取消调用。
  agent.onBeforeToolCall(
    'create-ticket',
    async (parameters) => {
      await delay(5);
      console.log(`before create-ticket: ${JSON.stringify(parameters)}`);
    },
    {
      await: true,
      errorCancel: true,
    },
  );

  agent.onBeforeToolCall(
    'estimate-effort',
    async () => {
      await delay(5);
      throw new Error('non-awaited before hook rejected');
    },
    {
      await: false,
      errorCancel: true,
    },
  );

  agent.onBeforeToolCall(
    'risky-operation',
    () => {
      throw new Error('blocked by before hook');
    },
    {
      await: true,
      errorCancel: true,
    },
  );

  agent.onAfterToolCall(
    'create-ticket',
    (_parameters, _message, result) => {
      console.log(`after create-ticket: ${serialize(result)}`);
    },
    {
      await: true,
    },
  );

  agent.onAfterToolCall(
    'append-ticket-note',
    () => {
      throw new Error('intentional after hook failure');
    },
    {
      await: true,
    },
  );

  agent.onAfterToolCall('summarize-board', (_parameters, _message, result) => {
    console.log(`after summarize-board: ${serialize(result)}`);
  });

  agent.onToolCallError((name, triggerType, error, _parameters, _message, result) => {
    const entry = `${name}/${triggerType}/${toErrorMessage(error)}${
      result === undefined ? '' : `/result=${serialize(result)}`
    }`;

    toolErrors.push(entry);
    console.log(`tool error: ${entry}`);
  });

  agent.onAgentError((error) => {
    console.log(`agent error event: ${error.message}`);
  });

  agent.init();

  console.log(`ark complex demo: baseURL=${baseURL} model=${modelName}`);
  console.log(`restored context messages before run=${agent.getContext().length}`);
  console.log(`restored history messages before run=${agent.getHistory().length}`);
  console.log(
    `static tools: parent=${ArkComplexDemoAgent.toolsDefinition
      .map((tool) => tool.name)
      .join(',')} sub=${QualityReviewAgent.toolsDefinition.map((tool) => tool.name).join(',')}`,
  );

  const finalContext = await agent.agent(
    [
      'Run the complex Ark Coding Plan integration demo.',
      'Please exercise the listed tools, the quality-reviewer sub-agent, runtime tool, restored context/history, and expected error paths.',
      'When the scenario is complete, call end-agent alone.',
    ].join('\n'),
  );

  await delay(20);

  console.log('ark complex demo summary');
  console.log(`final context messages=${finalContext.length}`);
  console.log(`history messages=${agent.getHistory().length}`);
  console.log(`system messages in context=${countRole(agent.getContext(), 'system')}`);
  console.log(`dynamic description builds=${memoryDescriptionBuilds}`);
  console.log(`model responses=${modelResponses.length}`);
  console.log(`tool errors observed=${toolErrors.length}`);
  console.log(`tools called=${[...calledTools].sort().join(',')}`);
  console.log(`runtime-state-report calls=${runtimeStateReportCalls}`);
  console.log(`unsubscribed model responses=${unsubscribedModelResponses}`);

  console.log('context:', agent.getContext());

  await runExpectedAgentErrorDemo(agent);
}

async function runExpectedAgentErrorDemo(agent: Agent): Promise<void> {
  try {
    await agent.agent('This streaming call should fail and emit onAgentError.', true);
  } catch (error) {
    console.log(`caught expected agent error: ${toErrorMessage(error)}`);
  }
}

function summarizeOutput(output: readonly AgentResponseOutputItem[]): string {
  return output
    .map((item) => {
      if (item.type === 'function_call' && 'name' in item) {
        return `function_call:${String(item.name)}`;
      }

      if (item.type === 'message' && 'role' in item) {
        return `message:${String(item.role)}`;
      }

      return item.type;
    })
    .join(', ');
}

function countRole(
  messages: readonly AgentContext[],
  role: 'system' | 'developer' | 'user' | 'assistant',
): number {
  return messages.filter((message) => 'role' in message && message.role === role).length;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : serialize(error);
}

function serialize(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
