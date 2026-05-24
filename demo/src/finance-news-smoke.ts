/**
 * 金融新闻离线冒烟 demo：以固定 RSS fixture 和固定模型调用顺序验证抓取、
 * 筛选、排序、简报生成及结束工具的完整链路。
 */
import type {
  ModelGenerateRequest,
  ModelGenerateResult,
  OpenAIResponsesProtocol,
} from '@manee/agent-framework';

import {
  defaultFinanceNewsSources,
  FinanceMarketNewsAgent,
  type FinanceNewsTransport,
} from './finance-news/agent';
import { ResponsesMockModel } from './responses-mock-model';

const fixedNow = new Date('2026-05-22T12:00:00.000Z');
const requiredTools = [
  'list-news-sources',
  'fetch-market-news',
  'filter-news',
  'rank-market-impact',
  'save-research-note',
  'build-market-briefing',
  'end-agent',
];

/** 逐轮返回预期工具调用，使离线测试不依赖网络或真实 LLM。 */
class FinanceNewsSmokeModel extends ResponsesMockModel {
  #round = 0;

  async generate(
    request: ModelGenerateRequest<OpenAIResponsesProtocol>,
  ): Promise<ModelGenerateResult<OpenAIResponsesProtocol>> {
    this.#round += 1;

    const toolNames = request.tools.map((tool) => tool.name);

    for (const toolName of requiredTools) {
      assertSmoke(toolNames.includes(toolName), `Expected tool to be available: ${toolName}`);
    }

    if (this.#round === 1) {
      return toolResponse('call_sources', 'list-news-sources', {});
    }

    if (this.#round === 2) {
      return toolResponse('call_fetch', 'fetch-market-news', {
        markets: ['us-equities', 'macro', 'crypto'],
        sinceHours: 72,
        maxItemsPerSource: 3,
      });
    }

    if (this.#round === 3) {
      return toolResponse('call_filter', 'filter-news', {
        markets: ['us-equities', 'macro', 'crypto'],
        keywords: ['Fed', 'SEC', 'Bitcoin', 'stocks'],
        sinceHours: 72,
        limit: 10,
      });
    }

    if (this.#round === 4) {
      return toolResponse('call_rank', 'rank-market-impact', {
        limit: 6,
      });
    }

    if (this.#round === 5) {
      return toolResponse('call_note', 'save-research-note', {
        note: '宏观政策、监管动态与加密资产新闻需要放在同一张风险地图里交叉阅读。',
      });
    }

    if (this.#round === 6) {
      return toolResponse('call_briefing', 'build-market-briefing', {
        title: '金融市场新闻 Smoke 简报',
        maxItems: 6,
      });
    }

    return toolResponse('call_end', 'end-agent', {});
  }
}

// fixture transport 取代远程 RSS 请求，使解析和排序断言完全可重复。
const fixtureByUrl = new Map(
  defaultFinanceNewsSources.map((source) => [source.url, buildFixtureFeed(source.id)]),
);

const mockTransport: FinanceNewsTransport = async (url) => {
  const xml = fixtureByUrl.get(url);

  if (!xml) {
    return {
      ok: false,
      status: 404,
      statusText: 'Not Found',
      async text() {
        return '';
      },
    };
  }

  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    async text() {
      return xml;
    },
  };
};

// 以下执行段既收集工具调用顺序，也核验最终简报已写入 Agent context。
const agent = new FinanceMarketNewsAgent(
  {
    llm: new FinanceNewsSmokeModel(),
    maxIterations: 10,
    systemPrompts: [
      'Run the deterministic finance market news smoke test. Use the full tool chain, build a Chinese briefing, then call end-agent alone.',
    ],
  },
  {
    transport: mockTransport,
    now: () => fixedNow,
  },
);
const calledTools: string[] = [];
let briefingMarkdown = '';
let fetchedItems = 0;

for (const toolName of requiredTools) {
  agent.onBeforeToolCall(toolName, (_parameters, message) => {
    calledTools.push(message.name);
    console.log(`tool: ${message.name} ${message.arguments}`);
  });
}

agent.onAfterToolCall('fetch-market-news', (_parameters, _message, result) => {
  const items = readArrayProperty(result, 'items');

  fetchedItems = items.length;
  console.log(`fetched items: ${fetchedItems}`);
});

agent.onAfterToolCall('build-market-briefing', (_parameters, _message, result) => {
  briefingMarkdown = readStringProperty(result, 'markdown');
  console.log('briefing built');
});

agent.onToolCallError((name, triggerType, error) => {
  const message = error instanceof Error ? error.message : String(error);

  console.log(`tool error: ${name}/${triggerType}/${message}`);
});

agent.init();

const finalContext = await agent.agent('Run the finance news smoke test.');

for (const toolName of requiredTools) {
  assertSmoke(calledTools.includes(toolName), `Expected tool call: ${toolName}`);
}

assertSmoke(fetchedItems >= 4, 'Expected RSS fixtures to produce at least four news items.');
assertSmoke(
  briefingMarkdown.includes('非投资建议') || briefingMarkdown.includes('不构成投资建议'),
  'Expected briefing to include a non-investment-advice disclaimer.',
);
assertSmoke(
  /\[[^\]]+\]\(https:\/\/example\.com\/finance-news\//.test(briefingMarkdown),
  'Expected briefing to include markdown source links.',
);
assertSmoke(
  finalContext.some(
    (message) =>
      message.type === 'function_call_output' &&
      'output' in message &&
      typeof message.output === 'string' &&
      message.output.includes('金融市场新闻 Smoke 简报'),
  ),
  'Expected final context to include the briefing tool result.',
);

console.log(`finance news smoke ready: messages=${finalContext.length}`);

function toolResponse(
  id: string,
  name: string,
  parameters: unknown,
): ModelGenerateResult<OpenAIResponsesProtocol> {
  return {
    messages: [
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

function buildFixtureFeed(sourceId: string): string {
  const fixtures: Record<string, Array<{ title: string; description: string; path: string }>> = {
    'fed-press': [
      {
        title: 'Federal Reserve signals patience on rate cuts as inflation cools',
        description: 'Fed officials discussed inflation, rates, Treasury yields, and market risk.',
        path: 'fed-rate-cuts',
      },
    ],
    'sec-press': [
      {
        title: 'SEC charges issuer over market disclosure controls',
        description: 'The SEC announced enforcement action tied to investor disclosure risk.',
        path: 'sec-disclosure',
      },
    ],
    'marketwatch-topstories': [
      {
        title: 'Stocks rise as Treasury yields fall after inflation data',
        description: 'US equities moved higher while the dollar softened and volatility eased.',
        path: 'stocks-yields-inflation',
      },
    ],
    'coindesk-rss': [
      {
        title: 'Bitcoin ETF flows surge while ether volatility rises',
        description: 'Crypto traders watched ETF approvals, Bitcoin demand, and ether volatility.',
        path: 'bitcoin-etf-flows',
      },
    ],
  };
  const items = fixtures[sourceId] ?? [];

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0">',
    '<channel>',
    `<title>${sourceId}</title>`,
    ...items.map((item) =>
      [
        '<item>',
        `<title>${escapeXml(item.title)}</title>`,
        `<link>https://example.com/finance-news/${item.path}</link>`,
        `<pubDate>${fixedNow.toUTCString()}</pubDate>`,
        `<description>${escapeXml(item.description)}</description>`,
        '</item>',
      ].join(''),
    ),
    '</channel>',
    '</rss>',
  ].join('');
}

function readArrayProperty(value: unknown, property: string): unknown[] {
  if (!value || typeof value !== 'object') {
    return [];
  }

  const record = value as Record<string, unknown>;
  const candidate = record[property];

  return Array.isArray(candidate) ? candidate : [];
}

function readStringProperty(value: unknown, property: string): string {
  if (!value || typeof value !== 'object') {
    return '';
  }

  const record = value as Record<string, unknown>;
  const candidate = record[property];

  return typeof candidate === 'string' ? candidate : '';
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function assertSmoke(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}
