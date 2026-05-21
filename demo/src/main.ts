import {
  Agent,
  Model,
  Tool,
  type ModelChatRequest,
  type ModelChatResponse,
} from '@manee/agent-framework';
import { z } from 'zod';

class MockModel extends Model {
  #round = 0;

  async chat(request: ModelChatRequest): Promise<ModelChatResponse> {
    this.#round += 1;

    const systemMessages = request.messages.filter((message) => message.role === 'system');
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

const agent = new DemoAgent({
  llm: new MockModel(),
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

const finalContext = await agent.agent('Run the demo task.');

console.log(`Demo ready: final context messages=${finalContext.length}`);
