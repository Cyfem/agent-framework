import { OpenAIModel, type AgentResponseOutputItem } from '@manee/agent-framework';

import { FinanceMarketNewsAgent } from './finance-news/agent';

const defaultArkBaseURL = 'https://ark.cn-beijing.volces.com/api/v3';
const defaultArkModel = 'doubao-seed-2-0-pro-260215';
const defaultTask = [
  '调研过去 72 小时的美股、宏观和加密市场新闻。',
  '请使用公开 RSS 新闻源，筛选重要新闻，按市场影响排序，并生成中文简报。',
  '保留原始英文标题和来源 URL，最后说明这不是投资建议。',
].join('\n');

const apiKey = process.env.ARK_API_KEY;

if (!apiKey) {
  console.error('Missing ARK_API_KEY. Run this demo with an Ark Coding Plan API key.');
  process.exitCode = 1;
} else {
  await runFinanceNewsDemo(apiKey);
}

async function runFinanceNewsDemo(apiKey: string): Promise<void> {
  const baseURL = process.env.ARK_BASE_URL ?? defaultArkBaseURL;
  const modelName = process.env.ARK_MODEL ?? defaultArkModel;
  const userTask =
    process.argv.slice(2).join(' ').trim() || process.env.FINANCE_NEWS_QUERY || defaultTask;

  const agent = new FinanceMarketNewsAgent({
    llm: new OpenAIModel({
      apiKey,
      baseURL,
      model: modelName,
    }),
    maxIterations: 12,
    systemPrompts: [
      [
        'You are a finance market news research demo agent.',
        'Default coverage is US equities, macro, and crypto.',
        'Use the available tools to fetch public RSS sources, filter relevant items, rank likely market impact, save one concise research note, and build the final Chinese briefing.',
        'Preserve original English news titles and source URLs in the briefing.',
        'The output is for research demo purposes only and must not be investment advice.',
        'Do not ask follow-up questions. When the briefing is built, call end-agent by itself.',
      ].join('\n'),
    ],
  });

  for (const toolName of [
    'list-news-sources',
    'fetch-market-news',
    'filter-news',
    'rank-market-impact',
    'save-research-note',
    'build-market-briefing',
  ]) {
    agent.onBeforeToolCall(toolName, (_parameters, message) => {
      console.log(`tool: ${message.name} ${message.arguments}`);
    });
  }

  agent.onAfterToolCall('build-market-briefing', (_parameters, _message, result) => {
    const markdown = readMarkdown(result);

    if (markdown) {
      console.log('\nfinance news briefing\n');
      console.log(markdown);
    }
  });

  agent.onModelResponse((output) => {
    console.log(`model: ${summarizeOutput(output)}`);
  });

  agent.onToolCallError((name, triggerType, error) => {
    const message = error instanceof Error ? error.message : String(error);

    console.log(`tool error: ${name}/${triggerType}/${message}`);
  });

  agent.onAgentError((error) => {
    console.log(`agent error: ${error.message}`);
  });

  agent.onAgentStatusChanged('running', () => {
    console.log('status: running');
  });

  agent.onAgentStatusChanged('ended', (_rawContext, context) => {
    console.log(`status: ended messages=${context.length}`);
  });

  agent.onAgentStatusChanged('failed', () => {
    console.log('status: failed');
  });

  agent.init();

  console.log(`finance news demo: baseURL=${baseURL} model=${modelName}`);
  console.log(`finance news task: ${userTask.replace(/\s+/g, ' ')}`);

  const finalContext = await agent.agent(userTask);

  console.log(`finance news demo complete: messages=${finalContext.length}`);
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

function readMarkdown(value: unknown): string {
  if (!value || typeof value !== 'object') {
    return '';
  }

  const markdown = (value as Record<string, unknown>).markdown;

  return typeof markdown === 'string' ? markdown : '';
}
