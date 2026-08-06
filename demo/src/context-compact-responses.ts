/**
 * 离线 Responses 示例：使用 summary-only 配置主动压缩 seed context。
 * 摘要请求仍复用真实 Responses builder/parser，但由本地 generate() 返回确定性 output。
 */
import {
  Agent,
  OpenAIResponsesModel,
  type ModelGenerateRequest,
  type ModelGenerateResult,
  type OpenAIResponsesContext,
  type OpenAIResponsesProtocol,
} from '@manee/agent-framework';

import { requireSucceededContext } from './run-outcome';

class OfflineSummaryResponsesModel extends OpenAIResponsesModel {
  summaryRequests = 0;
  agentRequests = 0;

  constructor() {
    super({
      apiKey: 'offline-responses-key',
      model: 'offline-responses-model',
    });
  }

  override async generate(
    request: ModelGenerateRequest<OpenAIResponsesProtocol>,
  ): Promise<ModelGenerateResult<OpenAIResponsesProtocol>> {
    if (request.purpose === 'context-summary') {
      this.summaryRequests += 1;
      assertDemo(request.tools.length === 0, 'Summary requests must not expose tools.');
      assertDemo(
        request.context.some((message) => readInputText(message).includes('older fact: alpha')),
        'Summary request must receive the selected original context.',
      );

      return {
        messages: [
          {
            type: 'message',
            id: 'summary_message',
            role: 'assistant',
            status: 'completed',
            content: [
              {
                type: 'output_text',
                text: 'Earlier context established the fact alpha.',
                annotations: [],
              },
            ],
          },
        ],
      };
    }

    this.agentRequests += 1;
    assertDemo(
      request.purpose === undefined,
      'Normal requests omit purpose for custom Model source compatibility.',
    );
    assertDemo(
      request.context.some((message) =>
        readInputText(message).includes('[Framework-generated summary of earlier context'),
      ),
      'Main request must use the synthetic active summary.',
    );

    return {
      messages: [
        {
          type: 'function_call',
          call_id: 'call_end',
          name: 'end-agent',
          arguments: '{}',
          status: 'completed',
        },
      ],
    };
  }
}

const model = new OfflineSummaryResponsesModel();
const seedMessage = model.buildUserMessage({
  content: [{ type: 'text', text: `older fact: alpha\n${'archive '.repeat(2_000)}` }],
});
let validatedSummary = '';

const agent = new Agent<OpenAIResponsesProtocol>({
  llm: model,
  initContext: [seedMessage],
  initRawContext: [seedMessage],
  contextCompact: {
    // 仅做摘要时必须显式关闭两类缺省工具压缩器。
    toolInput: false,
    toolResult: false,
    summary: {
      trigger: ({ iteration, previousSummary }) => iteration === 0 && previousSummary === undefined,
      prompt: ({ selection }) =>
        `请把以下 ${selection.contextToSummarize.length} 条历史消息压缩成事实记忆。`,
      validate: ({ summary }) => {
        validatedSummary = summary;
        return summary.includes('alpha')
          ? { ok: true }
          : { ok: false, reason: 'The summary lost the required fact.' };
      },
    },
  },
});

agent.init();
requireSucceededContext(
  await agent.agent('保留当前任务，同时压缩更早的 seed context。'),
  'Responses context compact Agent',
);

assertDemo(model.summaryRequests === 1, 'Expected one proactive summary request.');
assertDemo(model.agentRequests === 1, 'Expected one normal Agent request.');
assertDemo(
  validatedSummary.includes('alpha'),
  'Expected validate() to observe the candidate summary.',
);
assertDemo(
  agent.getHistory().some((message) => message === seedMessage),
  'Raw history must retain the original seed message.',
);
assertDemo(
  !agent
    .getHistory()
    .some((message) => readInputText(message).includes('[Framework-generated summary of earlier')),
  'Synthetic summary memory must not be written to raw history.',
);
assertDemo(
  agent
    .getContext()
    .some((message) => readInputText(message).includes('[Framework-generated summary of earlier')),
  'Active context must contain the committed summary memory.',
);

console.log('Responses summary compact demo passed:', {
  rawMessages: agent.getHistory().length,
  activeMessages: agent.getContext().length,
  summary: validatedSummary,
});

function readInputText(message: OpenAIResponsesContext): string {
  if (!('role' in message) || !Array.isArray(message.content)) {
    return '';
  }

  return message.content
    .flatMap((part) =>
      'text' in part && typeof part.text === 'string'
        ? [part.text]
        : 'refusal' in part && typeof part.refusal === 'string'
          ? [part.refusal]
          : [],
    )
    .join('\n');
}

function assertDemo(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}
