/**
 * 金融新闻 Agent 实现：将 RSS 获取、XML 归一化、筛选、影响力排序和 Markdown
 * 简报渲染拆成模型可调度的工具，同时保留可注入 transport 的离线测试边界。
 */
import {
  Agent,
  Tool,
  type AgentOptions,
  type OpenAIResponsesProtocol,
} from '@manee/agent-framework';
import { XMLParser } from 'fast-xml-parser';
import { z } from 'zod';

/** demo 关注的市场分组。 */
export type FinanceMarket = 'us-equities' | 'macro' | 'crypto';

/** 一个可抓取的公开 RSS 新闻源。 */
export interface NewsSource {
  id: string;
  name: string;
  market: FinanceMarket;
  url: string;
}

/** 从 RSS 条目归一化得到的新闻记录。 */
export interface MarketNewsItem {
  id: string;
  sourceId: string;
  market: FinanceMarket;
  title: string;
  link: string;
  publishedAt: string;
  summary: string;
}

/** 一轮抓取的成功条目与按源记录的错误。 */
export interface MarketNewsFetchResult {
  fetchedAt: string;
  items: MarketNewsItem[];
  errors: Array<{
    sourceId: string;
    message: string;
  }>;
}

/** 增加启发式影响评分和命中理由后的新闻记录。 */
export interface RankedMarketNewsItem extends MarketNewsItem {
  score: number;
  reasons: string[];
}

/** 可替代 `fetch` 的最小响应契约，便于 smoke demo 注入 fixture。 */
export interface FinanceNewsTransportResponse {
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
}

/** 新闻获取传输层函数，可在真实网络与离线 fixture 间替换。 */
export type FinanceNewsTransport = (
  url: string,
  init?: {
    headers?: Record<string, string>;
    signal?: AbortSignal;
  },
) => Promise<FinanceNewsTransportResponse>;

/** 金融新闻业务能力的可替换依赖。 */
export interface FinanceMarketNewsAgentOptions {
  sources?: readonly NewsSource[];
  transport?: FinanceNewsTransport;
  now?: () => Date;
}

const defaultMarkets: FinanceMarket[] = ['us-equities', 'macro', 'crypto'];
const marketSchema = z.enum(['us-equities', 'macro', 'crypto']);
const xmlParser = new XMLParser({
  attributeNamePrefix: '@_',
  ignoreAttributes: false,
  trimValues: true,
});

/** 默认的公开 RSS 来源；真实 demo 和离线 smoke 共用同一份来源配置。 */
export const defaultFinanceNewsSources: readonly NewsSource[] = [
  {
    id: 'fed-press',
    name: 'Federal Reserve Press Releases',
    market: 'macro',
    url: 'https://www.federalreserve.gov/feeds/press_all.xml',
  },
  {
    id: 'sec-press',
    name: 'SEC Press Releases',
    market: 'us-equities',
    url: 'https://www.sec.gov/news/pressreleases.rss',
  },
  {
    id: 'marketwatch-topstories',
    name: 'MarketWatch Top Stories',
    market: 'us-equities',
    url: 'https://feeds.marketwatch.com/marketwatch/topstories/',
  },
  {
    id: 'coindesk-rss',
    name: 'CoinDesk RSS',
    market: 'crypto',
    url: 'https://www.coindesk.com/arc/outboundfeeds/rss/',
  },
];

/**
 * 以工具链组织金融市场新闻调研的 Agent。
 *
 * 工具运行状态仅保存在本实例中，模型需要依次抓取、筛选和排序后再构建简报。
 */
export class FinanceMarketNewsAgent extends Agent<OpenAIResponsesProtocol> {
  #sources: NewsSource[];
  #transport: FinanceNewsTransport;
  #now: () => Date;
  #lastFetch: MarketNewsFetchResult | undefined;
  #filteredItems: MarketNewsItem[] = [];
  #rankedItems: RankedMarketNewsItem[] = [];
  #notes: string[] = [];

  constructor(
    options: AgentOptions<OpenAIResponsesProtocol>,
    financeOptions: FinanceMarketNewsAgentOptions = {},
  ) {
    super(options);
    this.#sources = [...(financeOptions.sources ?? defaultFinanceNewsSources)];
    this.#transport = financeOptions.transport ?? defaultTransport;
    this.#now = financeOptions.now ?? (() => new Date());
  }

  @Tool({
    name: 'list-news-sources',
    description:
      'List the configured public RSS sources for the finance market news research demo.',
    parameters: z.object({
      market: marketSchema.optional().describe('Optional market filter.'),
    }),
  })
  #listNewsSources(parameters: unknown): Record<string, unknown> {
    // 先让模型了解可抓取来源，便于后续选择市场或解释数据覆盖范围。
    const { market } = parameters as { market?: FinanceMarket };
    const sources = this.#sources.filter((source) => !market || source.market === market);

    return {
      count: sources.length,
      sources,
    };
  }

  @Tool({
    name: 'fetch-market-news',
    description:
      'Fetch and parse public RSS or Atom market news sources. Source failures are returned in errors and do not stop the whole research task.',
    parameters: z.object({
      markets: z.array(marketSchema).default(defaultMarkets),
      sinceHours: z.number().int().positive().max(720).default(72),
      maxItemsPerSource: z.number().int().positive().max(20).default(8),
      query: z.string().optional(),
    }),
  })
  async #fetchMarketNews(parameters: unknown): Promise<MarketNewsFetchResult> {
    // 抓取失败按源记录到 errors，不让单个 RSS 源影响整轮市场简报。
    const {
      markets = defaultMarkets,
      sinceHours = 72,
      maxItemsPerSource = 8,
      query,
    } = parameters as {
      markets?: FinanceMarket[];
      sinceHours?: number;
      maxItemsPerSource?: number;
      query?: string;
    };
    const selectedMarkets = new Set(markets);
    const selectedSources = this.#sources.filter((source) => selectedMarkets.has(source.market));
    const fetchedAt = this.#now().toISOString();
    const cutoff = this.#now().getTime() - sinceHours * 60 * 60 * 1000;
    const errors: MarketNewsFetchResult['errors'] = [];
    const items: MarketNewsItem[] = [];

    for (const source of selectedSources) {
      try {
        const requestInit: Parameters<FinanceNewsTransport>[1] = {
          headers: {
            Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml',
            'User-Agent': 'agent-framework-finance-news-demo/0.0.0',
          },
        };
        const timeoutSignal = makeTimeoutSignal(15_000);

        if (timeoutSignal) {
          requestInit.signal = timeoutSignal;
        }

        const response = await this.#transport(source.url, requestInit);

        if (!response.ok) {
          throw new Error(`${response.status} ${response.statusText}`.trim());
        }

        const xml = await response.text();
        const parsedItems = parseFeedItems(xml, source)
          .filter((item) => isRecentEnough(item, cutoff))
          .filter((item) => matchesQuery(item, query))
          .slice(0, maxItemsPerSource);

        items.push(...parsedItems);
      } catch (error) {
        errors.push({
          sourceId: source.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.#lastFetch = {
      fetchedAt,
      items,
      errors,
    };
    this.#filteredItems = items;
    this.#rankedItems = [];

    return this.#lastFetch;
  }

  @Tool({
    name: 'filter-news',
    description:
      'Filter fetched market news by market, keyword, and age. Call fetch-market-news first.',
    parameters: z.object({
      markets: z.array(marketSchema).default(defaultMarkets),
      keywords: z.array(z.string().min(1)).default([]),
      sinceHours: z.number().int().positive().max(720).default(72),
      limit: z.number().int().positive().max(50).default(20),
    }),
  })
  #filterNews(parameters: unknown): Record<string, unknown> {
    // 过滤阶段只消费上一轮抓取缓存，避免模型重复请求远程 RSS。
    const {
      markets = defaultMarkets,
      keywords = [],
      sinceHours = 72,
      limit = 20,
    } = parameters as {
      markets?: FinanceMarket[];
      keywords?: string[];
      sinceHours?: number;
      limit?: number;
    };
    const marketSet = new Set(markets);
    const cutoff = this.#now().getTime() - sinceHours * 60 * 60 * 1000;
    const normalizedKeywords = keywords.map((keyword) => keyword.trim().toLowerCase());
    const filtered = (this.#lastFetch?.items ?? [])
      .filter((item) => marketSet.has(item.market))
      .filter((item) => isRecentEnough(item, cutoff))
      .filter((item) => {
        if (normalizedKeywords.length === 0) {
          return true;
        }

        const haystack = `${item.title}\n${item.summary}`.toLowerCase();
        return normalizedKeywords.some((keyword) => haystack.includes(keyword));
      })
      .slice(0, limit);

    this.#filteredItems = filtered;
    this.#rankedItems = [];

    return {
      count: filtered.length,
      items: filtered,
      sourceErrors: this.#lastFetch?.errors ?? [],
    };
  }

  @Tool({
    name: 'rank-market-impact',
    description:
      'Rank filtered news by likely market impact using transparent keyword heuristics for this demo.',
    parameters: z.object({
      limit: z.number().int().positive().max(20).default(10),
    }),
  })
  #rankMarketImpact(parameters: unknown): Record<string, unknown> {
    // demo 使用启发式打分展示影响排序，不构成投资建议或交易信号。
    const { limit = 10 } = parameters as { limit?: number };
    const sourceItems =
      this.#filteredItems.length > 0 ? this.#filteredItems : (this.#lastFetch?.items ?? []);
    const ranked = sourceItems
      .map(rankItem)
      .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title))
      .slice(0, limit);

    this.#rankedItems = ranked;

    return {
      count: ranked.length,
      items: ranked,
    };
  }

  @Tool({
    name: 'save-research-note',
    description: 'Save one concise research note that should be included in the final briefing.',
    parameters: z.object({
      note: z.string().min(1),
    }),
  })
  #saveResearchNote(parameters: unknown): Record<string, unknown> {
    // 允许模型把中间判断写成 note，最终 briefing 会合并这些观察。
    const { note } = parameters as { note: string };

    this.#notes.push(note);

    return {
      saved: true,
      count: this.#notes.length,
      notes: this.#notes,
    };
  }

  @Tool({
    name: 'build-market-briefing',
    description:
      'Build a Chinese finance market news briefing with original titles, source links, and a non-investment-advice disclaimer.',
    parameters: z.object({
      title: z.string().default('金融市场新闻简报'),
      maxItems: z.number().int().positive().max(12).default(8),
    }),
  })
  #buildMarketBriefing(parameters: unknown): Record<string, unknown> {
    // 最终工具把排序结果和 note 渲染为 Markdown，方便 demo 直接打印。
    const { title = '金融市场新闻简报', maxItems = 8 } = parameters as {
      title?: string;
      maxItems?: number;
    };
    const rankedItems =
      this.#rankedItems.length > 0 ? this.#rankedItems : this.#filteredItems.map(rankItem);
    const topItems = rankedItems.slice(0, maxItems);
    const grouped = groupByMarket(topItems);
    const lines = [
      `# ${title}`,
      '',
      `生成时间：${this.#now().toISOString()}`,
      '',
      '说明：以下内容仅用于新闻调研 demo，不构成投资建议。',
      '',
      '## 关键观察',
      ...buildObservationLines(topItems, this.#notes),
      '',
      '## 分市场新闻',
      ...buildMarketLines(grouped),
      '',
      '## 数据质量',
      `- 已解析新闻：${this.#lastFetch?.items.length ?? 0} 条`,
      `- 源错误：${this.#lastFetch?.errors.length ?? 0} 个`,
      ...(this.#lastFetch?.errors ?? []).map((error) => `- ${error.sourceId}: ${error.message}`),
    ];
    const markdown = lines.join('\n');

    return {
      title,
      itemCount: topItems.length,
      sourceErrors: this.#lastFetch?.errors ?? [],
      notes: this.#notes,
      markdown,
    };
  }
}

/** 真实运行默认使用平台 `fetch` 获取 RSS 内容。 */
async function defaultTransport(
  url: string,
  init?: {
    headers?: Record<string, string>;
    signal?: AbortSignal;
  },
): Promise<FinanceNewsTransportResponse> {
  return fetch(url, init);
}

function makeTimeoutSignal(timeoutMs: number): AbortSignal | undefined {
  if (typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(timeoutMs);
  }

  return undefined;
}

// RSS 与 Atom 的字段形态不同；解析层先统一成内部 MarketNewsItem，再交给工具筛选。
function parseFeedItems(xml: string, source: NewsSource): MarketNewsItem[] {
  const parsed = xmlParser.parse(xml) as unknown;
  const feed = getFeedRoot(parsed);
  const rawItems = getRawItems(feed);

  return rawItems
    .map((rawItem) => normalizeFeedItem(rawItem, source))
    .filter((item): item is MarketNewsItem => item !== null);
}

function getFeedRoot(parsed: unknown): unknown {
  if (!isRecord(parsed)) {
    return {};
  }

  const rss = parsed.rss;

  if (isRecord(rss) && rss.channel) {
    return rss.channel;
  }

  if (parsed.feed) {
    return parsed.feed;
  }

  return parsed;
}

function getRawItems(feed: unknown): unknown[] {
  if (!isRecord(feed)) {
    return [];
  }

  return asArray(feed.item ?? feed.entry);
}

function normalizeFeedItem(rawItem: unknown, source: NewsSource): MarketNewsItem | null {
  if (!isRecord(rawItem)) {
    return null;
  }

  const title = cleanText(readText(rawItem.title));
  const link = cleanText(readLink(rawItem.link));
  const publishedAt = normalizeDate(
    readText(rawItem.pubDate) ||
      readText(rawItem.published) ||
      readText(rawItem.updated) ||
      readText(rawItem['dc:date']),
  );
  const summary = cleanText(
    readText(rawItem.description) ||
      readText(rawItem.summary) ||
      readText(rawItem.content) ||
      readText(rawItem['content:encoded']),
  );

  if (!title || !link) {
    return null;
  }

  return {
    id: `${source.id}:${hashString(`${link}\n${title}\n${publishedAt}`)}`,
    sourceId: source.id,
    market: source.market,
    title,
    link,
    publishedAt,
    summary,
  };
}

function readLink(value: unknown): string {
  if (Array.isArray(value)) {
    const alternate = value.find((item) => isRecord(item) && item['@_href']);

    if (alternate) {
      return readLink(alternate);
    }

    return readLink(value[0]);
  }

  if (isRecord(value)) {
    return readText(value['@_href'] ?? value.href ?? value['#text']);
  }

  return readText(value);
}

function readText(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value.map(readText).filter(Boolean).join(' ');
  }

  if (isRecord(value)) {
    return readText(value['#text'] ?? value.text ?? value._);
  }

  return '';
}

function normalizeDate(value: string): string {
  const parsed = Date.parse(value);

  if (Number.isNaN(parsed)) {
    return new Date(0).toISOString();
  }

  return new Date(parsed).toISOString();
}

function isRecentEnough(item: MarketNewsItem, cutoff: number): boolean {
  const publishedAt = Date.parse(item.publishedAt);

  if (Number.isNaN(publishedAt) || publishedAt === 0) {
    return true;
  }

  return publishedAt >= cutoff;
}

function matchesQuery(item: MarketNewsItem, query: string | undefined): boolean {
  const normalized = query?.trim().toLowerCase();

  if (!normalized) {
    return true;
  }

  return `${item.title}\n${item.summary}`.toLowerCase().includes(normalized);
}

// demo 使用透明的关键词打分展示“影响排序”步骤，不将其包装为投资建议。
function rankItem(item: MarketNewsItem): RankedMarketNewsItem {
  const text = `${item.title}\n${item.summary}`.toLowerCase();
  const rules: Array<{
    reason: string;
    score: number;
    keywords: string[];
  }> = [
    {
      reason: 'central-bank-or-rates',
      score: 35,
      keywords: ['fed', 'federal reserve', 'rate', 'inflation', 'fomc', 'treasury'],
    },
    {
      reason: 'regulatory-or-enforcement',
      score: 25,
      keywords: ['sec', 'charges', 'settlement', 'enforcement', 'approval', 'etf'],
    },
    {
      reason: 'market-moving-language',
      score: 20,
      keywords: ['stocks', 'market', 'earnings', 'yield', 'dollar', 'bitcoin', 'ether'],
    },
    {
      reason: 'risk-language',
      score: 15,
      keywords: ['risk', 'volatility', 'warning', 'cuts', 'hikes', 'surge', 'falls'],
    },
  ];
  const reasons: string[] = [];
  let score = 10;

  for (const rule of rules) {
    if (rule.keywords.some((keyword) => text.includes(keyword))) {
      score += rule.score;
      reasons.push(rule.reason);
    }
  }

  if (item.market === 'macro') {
    score += 10;
    reasons.push('macro-source');
  }

  return {
    ...item,
    score,
    reasons: [...new Set(reasons)],
  };
}

function groupByMarket(
  items: readonly RankedMarketNewsItem[],
): Map<FinanceMarket, RankedMarketNewsItem[]> {
  const grouped = new Map<FinanceMarket, RankedMarketNewsItem[]>();

  for (const item of items) {
    const group = grouped.get(item.market) ?? [];

    group.push(item);
    grouped.set(item.market, group);
  }

  return grouped;
}

// 渲染层只消费归一化和排序后的结果，便于测试直接断言最终 Markdown。
function buildObservationLines(
  items: readonly RankedMarketNewsItem[],
  notes: readonly string[],
): string[] {
  if (items.length === 0 && notes.length === 0) {
    return ['- 暂无可用于生成观察的新闻。'];
  }

  const lines = notes.map((note) => `- ${note}`);

  for (const item of items.slice(0, 3)) {
    lines.push(`- ${marketLabel(item.market)}：${item.title}（影响分 ${item.score}）`);
  }

  return lines;
}

function buildMarketLines(
  grouped: ReadonlyMap<FinanceMarket, readonly RankedMarketNewsItem[]>,
): string[] {
  const lines: string[] = [];

  for (const market of defaultMarkets) {
    const items = grouped.get(market) ?? [];

    if (items.length === 0) {
      continue;
    }

    lines.push(`### ${marketLabel(market)}`);

    for (const item of items) {
      lines.push(
        `- [${item.title}](${item.link}) | source=${item.sourceId} | published=${item.publishedAt} | score=${item.score}`,
      );
    }

    lines.push('');
  }

  return lines.length > 0 ? lines : ['- 暂无匹配新闻。'];
}

function marketLabel(market: FinanceMarket): string {
  const labels: Record<FinanceMarket, string> = {
    'us-equities': '美股',
    macro: '宏观',
    crypto: '加密',
  };

  return labels[market];
}

function cleanText(value: string): string {
  return value
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hashString(value: string): string {
  let hash = 5381;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }

  return (hash >>> 0).toString(36);
}
