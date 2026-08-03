/**
 * 离线 Responses Context Compact 与错误恢复验收套件。
 *
 * 使用真实 Responses builder/parser，但由队列模型提供确定性 output：覆盖主动 rolling
 * summary、previousSummary/select/prompt/validate、context-length 紧急摘要与恢复 hooks、
 * summary purpose 防递归，以及一次普通 unknown 错误重试。
 */
import {
  Agent,
  OpenAIResponsesModel,
  type AgentSkill,
  type AfterModelErrorRecoveryEvent,
  type BeforeModelErrorRecoveryEvent,
  type ModelErrorDescriptor,
  type ModelGenerateRequest,
  type ModelGenerateResult,
  type OpenAIResponsesContext,
  type OpenAIResponsesProtocol,
  type SummaryCompactSnapshot,
} from '@manee/agent-framework';

type GenerateEntry =
  | Error
  | ModelGenerateResult<OpenAIResponsesProtocol>
  | ((
      request: ModelGenerateRequest<OpenAIResponsesProtocol>,
      requestNumber: number,
    ) =>
      | ModelGenerateResult<OpenAIResponsesProtocol>
      | Promise<ModelGenerateResult<OpenAIResponsesProtocol>>);

class ContextLengthDemoError extends Error {}

class OfflineResponsesQueueModel extends OpenAIResponsesModel {
  readonly requests: ModelGenerateRequest<OpenAIResponsesProtocol>[] = [];

  constructor(private readonly entries: GenerateEntry[]) {
    super({ apiKey: 'offline-responses-key', model: 'offline-responses-model' });
  }

  override async generate(
    request: ModelGenerateRequest<OpenAIResponsesProtocol>,
  ): Promise<ModelGenerateResult<OpenAIResponsesProtocol>> {
    const snapshot = {
      context: [...request.context],
      tools: [...request.tools],
      ...('purpose' in request ? { purpose: request.purpose } : {}),
    } satisfies ModelGenerateRequest<OpenAIResponsesProtocol>;
    this.requests.push(snapshot);

    const entry = this.entries.shift();
    assertDemo(entry !== undefined, 'Offline Responses response queue is empty.');
    if (entry instanceof Error) throw entry;

    return typeof entry === 'function' ? entry(snapshot, this.requests.length) : entry;
  }

  override classifyError(error: unknown): ModelErrorDescriptor {
    if (error instanceof ContextLengthDemoError) {
      return {
        kind: 'context_length_exceeded',
        message: error.message,
        provider: 'offline-responses',
        providerCode: 'context_length_exceeded',
        status: 400,
        requestId: `offline-${error.message}`,
      };
    }

    return {
      kind: 'unknown',
      message: error instanceof Error ? error.message : String(error),
      provider: 'offline-responses',
    };
  }
}

await runRollingSummaryScenario();
await runEmergencyRecoveryScenario();
await runUnknownRetryScenario();
await runSkillSummaryScenario();

console.log('Responses Context Compact offline suite passed:', {
  scenarios: 4,
  rollingSummaries: 2,
  emergencyRecoveries: 1,
  unknownRetries: 1,
  skillSummaries: 1,
});

async function runRollingSummaryScenario(): Promise<void> {
  const model = new OfflineResponsesQueueModel([
    (request) => {
      assertSummaryRequest(request, 'older fact: alpha', 'rolling prompt 0');
      return response(outputMessage('rolling-summary-one', 'rolling summary one preserves alpha'));
    },
    (request) => {
      assertNormalRequest(request);
      assertDemo(
        contextText(request.context).includes('rolling summary one preserves alpha') &&
          contextText(request.context).includes('current rolling task'),
        'The first main request must use summary one and preserve the current task.',
      );
      return response(outputMessage('first-loop-output', 'first-loop-output'));
    },
    (request) => {
      assertSummaryRequest(request, 'rolling summary one preserves alpha', 'rolling prompt 1');
      assertDemo(
        contextText(request.context).includes('current rolling task'),
        'The second summary must roll the previous summary together with the earlier task span.',
      );
      return response(outputMessage('rolling-summary-two', 'rolling summary two preserves alpha'));
    },
    (request) => {
      assertNormalRequest(request);
      const text = contextText(request.context);
      assertDemo(
        text.includes('rolling summary two preserves alpha') && text.includes('first-loop-output'),
        'The second main request must use summary two and preserve the latest complete span.',
      );
      return response(endCall('rolling-end'));
    },
  ]);
  const seed = model.buildUserMessage({
    content: [{ type: 'text', text: `older fact: alpha\n${'archive '.repeat(500)}` }],
  });
  const snapshots: SummaryCompactSnapshot<OpenAIResponsesProtocol>[] = [];
  const validated: string[] = [];
  const modelResponseIds: string[] = [];

  const agent = new Agent<OpenAIResponsesProtocol>({
    llm: model,
    initContext: [seed],
    initRawContext: [seed],
    contextCompact: {
      toolInput: false,
      toolResult: false,
      summary: {
        trigger: (snapshot) => {
          snapshots.push(snapshot);
          return snapshot.iteration < 2;
        },
        select: (snapshot) => {
          if (snapshot.iteration !== 0) return undefined;
          return {
            contextToSummarize: snapshot.boundaryOriginalContext.slice(0, -1),
            preservedContext: snapshot.boundaryActiveContext.slice(-1),
          };
        },
        prompt: ({ iteration, previousSummary, selection }) => {
          if (iteration === 0) {
            assertDemo(previousSummary === undefined, 'The first summary has no previousSummary.');
            assertDemo(
              selection.contextToSummarize.length === 1 && selection.preservedContext.length === 1,
              'Custom select must summarize only the seed and preserve the current task.',
            );
          } else {
            assertDemo(
              previousSummary?.text === 'rolling summary one preserves alpha',
              'The next prompt must receive the committed previousSummary.',
            );
          }
          return `rolling prompt ${iteration}`;
        },
        validate: ({ iteration, summary, candidateActiveContext }) => {
          validated.push(summary);
          return summary.includes('alpha') && candidateActiveContext.length > 1
            ? { ok: true }
            : { ok: false, reason: `rolling summary ${iteration} lost alpha or active context` };
        },
      },
    },
  });
  agent.onModelResponse((messages) => {
    modelResponseIds.push(...contextIds(messages));
  });
  agent.init();
  await agent.agent('current rolling task');

  assertDemo(snapshots.length === 2, 'Proactive trigger must run once per Agent iteration.');
  assertDemo(
    snapshots[1]?.previousSummary?.text === 'rolling summary one preserves alpha',
    'The second trigger must expose previousSummary.',
  );
  assertDeepEqual(
    validated,
    ['rolling summary one preserves alpha', 'rolling summary two preserves alpha'],
    'validate() must observe both rolling candidates in order.',
  );
  assertDeepEqual(
    modelResponseIds,
    ['first-loop-output', 'rolling-end'],
    'Only normal model responses may emit onModelResponse.',
  );
  assertDeepEqual(
    model.requests.map((request) => request.purpose ?? 'agent'),
    ['context-summary', 'agent', 'context-summary', 'agent'],
    'Rolling requests must alternate summary and normal purposes.',
  );
  assertDemo(
    agent.getHistory().includes(seed),
    'Raw history must retain the original seed object.',
  );
  assertDemo(
    !contextText(agent.getHistory()).includes('[Framework-generated summary of earlier context') &&
      !contextText(agent.getHistory()).includes('rolling summary one preserves alpha') &&
      !contextText(agent.getHistory()).includes('rolling summary two preserves alpha') &&
      !contextIds(agent.getHistory()).includes('rolling-summary-one') &&
      !contextIds(agent.getHistory()).includes('rolling-summary-two'),
    'Neither synthetic messages nor provider summary responses may enter raw history.',
  );
  assertDemo(
    contextText(agent.getContext()).includes('rolling summary two preserves alpha'),
    'Active context must contain the latest rolling summary.',
  );
}

async function runEmergencyRecoveryScenario(): Promise<void> {
  const outerOverflow = new ContextLengthDemoError('agent-overflow');
  const summaryOverflow = new ContextLengthDemoError('summary-overflow');
  const model = new OfflineResponsesQueueModel([
    outerOverflow,
    summaryOverflow,
    (request) => {
      assertSummaryRequest(request, 'emergency seed fact', 'emergency prompt');
      assertDemo(
        contextText(request.context).includes('emergency current task'),
        'Emergency default selection must summarize the entire current boundary.',
      );
      return response(outputMessage('emergency-summary', 'emergency fact retained'));
    },
    (request) => {
      assertNormalRequest(request);
      assertDemo(
        contextText(request.context).includes('emergency fact retained'),
        'The retried normal request must use the emergency synthetic summary.',
      );
      return response(endCall('emergency-end'));
    },
  ]);
  const seed = model.buildUserMessage({
    content: [{ type: 'text', text: 'emergency seed fact' }],
  });
  const beforeEvents: BeforeModelErrorRecoveryEvent<OpenAIResponsesProtocol>[] = [];
  const afterEvents: AfterModelErrorRecoveryEvent<OpenAIResponsesProtocol>[] = [];
  let proactiveTriggers = 0;

  const agent = new Agent<OpenAIResponsesProtocol>({
    llm: model,
    initContext: [seed],
    initRawContext: [seed],
    modelErrorRecovery: {
      unhandledRetryLimit: 1,
      contextLengthRecoveryLimit: 1,
    },
    contextCompact: {
      toolInput: false,
      toolResult: false,
      summary: {
        trigger: () => {
          proactiveTriggers += 1;
          return false;
        },
        prompt: ({ cause, selection }) => {
          assertDemo(
            cause.type === 'context_length_exceeded' &&
              cause.cause === outerOverflow &&
              cause.error.providerCode === 'context_length_exceeded',
            'Emergency prompt must receive the classified original provider error.',
          );
          assertDemo(
            selection.contextToSummarize.length === 2 && selection.preservedContext.length === 0,
            'Emergency default selection must compact the entire boundary.',
          );
          return 'emergency prompt';
        },
        validate: ({ summary }) =>
          summary.includes('emergency fact')
            ? { ok: true }
            : { ok: false, reason: 'Emergency summary lost the required fact.' },
      },
    },
  });
  agent.onBeforeModelErrorRecovery((event) => {
    beforeEvents.push(event);
  });
  agent.onAfterModelErrorRecovery((event) => {
    afterEvents.push(event);
  });
  agent.init();
  await agent.agent('emergency current task');

  assertDemo(
    proactiveTriggers === 1,
    'Model retries and emergency summary generation must not repeat the proactive trigger.',
  );
  assertDeepEqual(
    model.requests.map((request) => request.purpose ?? 'agent'),
    ['agent', 'context-summary', 'context-summary', 'agent'],
    'Emergency recovery must retry summary purpose without recursively invoking its handler.',
  );
  assertDemo(
    model.requests
      .filter((request) => request.purpose === 'context-summary')
      .every((request) => request.tools.length === 0),
    'Every emergency summary attempt must hide tools.',
  );

  const outerBefore = beforeEvents.find((event) => event.cause === outerOverflow);
  const summaryBefore = beforeEvents.find((event) => event.cause === summaryOverflow);
  const outerAfter = afterEvents.find((event) => event.cause === outerOverflow);
  const summaryAfter = afterEvents.find((event) => event.cause === summaryOverflow);
  assertDemo(
    outerBefore?.purpose === 'agent' &&
      outerBefore.matchedHandler?.id === 'core.context_compaction' &&
      outerBefore.defaultAction === 'retry' &&
      outerBefore.requestAttempt === 1,
    'Before hook must expose the matched core context compaction handler.',
  );
  assertDemo(
    summaryBefore?.purpose === 'context-summary' &&
      summaryBefore.matchedHandler === undefined &&
      summaryBefore.requestAttempt === 1,
    'A summary overflow must not recursively match the context compaction handler.',
  );
  assertDemo(
    summaryAfter?.handlerOutcome === 'not-run' && summaryAfter.proposedAction === 'retry',
    'The summary overflow must use ordinary retry recovery.',
  );
  assertDemo(
    outerAfter?.handlerOutcome === 'succeeded' &&
      outerAfter.proposedAction === 'retry' &&
      outerAfter.ledger.contextRecoveryAttempts === 1 &&
      outerAfter.contextRevision > (outerBefore?.contextRevision ?? Number.MAX_SAFE_INTEGER),
    'After hook must report a committed emergency summary before retrying.',
  );
  assertDemo(
    !contextText(agent.getHistory()).includes('[Framework-generated summary of earlier context') &&
      !contextText(agent.getHistory()).includes('emergency fact retained') &&
      !contextIds(agent.getHistory()).includes('emergency-summary') &&
      contextText(agent.getContext()).includes('emergency fact retained'),
    'Emergency provider/synthetic summaries must be active-only while raw history stays original.',
  );
}

async function runUnknownRetryScenario(): Promise<void> {
  const transient = new Error('one transient unknown error');
  const model = new OfflineResponsesQueueModel([
    transient,
    (request) => {
      assertNormalRequest(request);
      return response(endCall('unknown-retry-end'));
    },
  ]);
  const beforeEvents: BeforeModelErrorRecoveryEvent<OpenAIResponsesProtocol>[] = [];
  const afterEvents: AfterModelErrorRecoveryEvent<OpenAIResponsesProtocol>[] = [];
  let proactiveTriggers = 0;
  const agent = new Agent<OpenAIResponsesProtocol>({
    llm: model,
    modelErrorRecovery: {
      unhandledRetryLimit: 1,
      contextLengthRecoveryLimit: 1,
    },
    contextCompact: {
      toolInput: false,
      toolResult: false,
      summary: {
        trigger: () => {
          proactiveTriggers += 1;
          return false;
        },
        prompt: () => 'unused unknown retry summary prompt',
      },
    },
  });
  agent.onBeforeModelErrorRecovery((event) => {
    beforeEvents.push(event);
  });
  agent.onAfterModelErrorRecovery((event) => {
    afterEvents.push(event);
  });
  agent.init();
  await agent.agent('retry one unknown model error');

  assertDemo(model.requests.length === 2, 'Unknown recovery must perform exactly one retry.');
  assertDemo(proactiveTriggers === 1, 'Unknown retry must not repeat the proactive trigger.');
  assertDemo(
    beforeEvents.length === 1 &&
      beforeEvents[0]?.cause === transient &&
      beforeEvents[0].descriptor.kind === 'unknown' &&
      beforeEvents[0].matchedHandler === undefined &&
      beforeEvents[0].ledger.unhandledRetries === 0,
    'Unknown before hook must expose the original cause and initial ledger.',
  );
  assertDemo(
    afterEvents.length === 1 &&
      afterEvents[0]?.handlerOutcome === 'not-run' &&
      afterEvents[0].proposedAction === 'retry',
    'Unknown after hook must report an ordinary retry without a handler.',
  );
}

async function runSkillSummaryScenario(): Promise<void> {
  const skill: AgentSkill = {
    name: 'summary-source-skill',
    description: 'Provide a long fact that a later summary must consume.',
    instructions: `skill-summary-source-marker\n${'skill source '.repeat(1_000)}`,
  };
  const resultCompactorCallIds: string[] = [];
  let proactiveTriggers = 0;
  const model = new OfflineResponsesQueueModel([
    (request) => {
      assertNormalRequest(request);
      return response(skillCall('skill-summary-load', skill.name));
    },
    (request) => {
      assertSummaryRequest(request, 'skill-summary-source-marker', 'summarize Skill output');
      assertDemo(
        contextText(request.context).includes('skill source skill source'),
        'The summary request must receive the original, default-uncompacted Skill result.',
      );
      return response(
        outputMessage('skill-consumed-summary', 'summary consumed skill-summary-source-marker'),
      );
    },
    (request) => {
      assertNormalRequest(request);
      const text = contextText(request.context);
      assertDemo(
        text.includes('summary consumed skill-summary-source-marker') &&
          !text.includes('skill source skill source'),
        'The next normal request must use the summary instead of the long Skill result.',
      );
      return response(endCall('skill-summary-end'));
    },
  ]);
  const agent = new Agent<OpenAIResponsesProtocol>({
    llm: model,
    skills: [skill],
    contextCompact: {
      toolInput: false,
      toolResult: (original, info) => {
        resultCompactorCallIds.push(info.call.id);
        return original;
      },
      summary: {
        trigger: ({ iteration }) => {
          proactiveTriggers += 1;
          return iteration === 1;
        },
        select: (snapshot) => ({
          contextToSummarize: snapshot.boundaryOriginalContext,
          preservedContext: [],
        }),
        prompt: () => 'summarize Skill output',
        validate: ({ summary }) =>
          summary.includes('skill-summary-source-marker')
            ? { ok: true }
            : { ok: false, reason: 'Skill marker was lost by summary.' },
      },
    },
  });
  agent.init();
  await agent.agent('Load the Skill and summarize its long result.');

  const rawSkillResult = readResponsesOutput(agent.getHistory(), 'skill-summary-load');
  assertDeepEqual(
    resultCompactorCallIds,
    ['skill-summary-end'],
    'The built-in Skill result must skip payload result compact while ordinary tools stay eligible.',
  );
  assertDemo(
    proactiveTriggers === 2,
    'Skill summary trigger must run once before each normal Agent iteration.',
  );
  assertDemo(
    rawSkillResult.includes('skill-summary-source-marker') &&
      rawSkillResult.includes('skill source skill source'),
    'Raw history must retain the complete original Skill result after summary commit.',
  );
  assertDemo(
    !contextIds(agent.getHistory()).includes('skill-consumed-summary') &&
      !contextText(agent.getHistory()).includes('summary consumed skill-summary-source-marker'),
    'The provider summary response must not leak into raw history.',
  );
  assertDemo(
    contextText(agent.getContext()).includes('summary consumed skill-summary-source-marker') &&
      !contextText(agent.getContext()).includes('skill source skill source'),
    'Summary must absorb the default-uncompacted Skill result into active context.',
  );
}

function response(
  ...messages: readonly OpenAIResponsesContext[]
): ModelGenerateResult<OpenAIResponsesProtocol> {
  return { messages };
}

function outputMessage(id: string, text: string): OpenAIResponsesContext {
  return {
    type: 'message',
    id,
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
}

function endCall(callId: string): OpenAIResponsesContext {
  return {
    type: 'function_call',
    call_id: callId,
    name: 'end-agent',
    arguments: '{}',
    status: 'completed',
  };
}

function skillCall(callId: string, skill: string): OpenAIResponsesContext {
  return {
    type: 'function_call',
    call_id: callId,
    name: 'skill',
    arguments: JSON.stringify({ skill }),
    status: 'completed',
  };
}

function assertSummaryRequest(
  request: ModelGenerateRequest<OpenAIResponsesProtocol>,
  expectedContext: string,
  expectedPrompt: string,
): void {
  assertDemo(request.purpose === 'context-summary', 'Summary request must set its purpose.');
  assertDemo(request.tools.length === 0, 'Summary request must not expose tools.');
  const text = contextText(request.context);
  assertDemo(
    text.includes(expectedContext) && text.includes(expectedPrompt),
    'Summary request must contain the selected context and external prompt.',
  );
}

function assertNormalRequest(request: ModelGenerateRequest<OpenAIResponsesProtocol>): void {
  assertDemo(
    request.purpose === undefined && !('purpose' in request),
    'Normal requests must omit purpose for custom Model source compatibility.',
  );
}

function contextText(context: readonly OpenAIResponsesContext[]): string {
  const texts: string[] = [];

  for (const message of context) {
    if (message.type === 'function_call_output' && typeof message.output === 'string') {
      texts.push(message.output);
      continue;
    }
    if (!('content' in message)) continue;
    if (typeof message.content === 'string') {
      texts.push(message.content);
      continue;
    }
    if (!Array.isArray(message.content)) continue;

    for (const part of message.content) {
      if ('text' in part && typeof part.text === 'string') texts.push(part.text);
      if ('refusal' in part && typeof part.refusal === 'string') texts.push(part.refusal);
    }
  }

  return texts.join('\n');
}

function contextIds(context: readonly OpenAIResponsesContext[]): string[] {
  return context.flatMap((message) => {
    if (message.type === 'message' && 'id' in message && typeof message.id === 'string') {
      return [message.id];
    }
    if (message.type === 'function_call') return [message.call_id];
    return [];
  });
}

function readResponsesOutput(context: readonly OpenAIResponsesContext[], callId: string): string {
  const output = context.find(
    (message) => message.type === 'function_call_output' && message.call_id === callId,
  );
  assertDemo(output?.type === 'function_call_output', `Expected Responses output for ${callId}.`);
  assertDemo(typeof output.output === 'string', `Expected string Responses output for ${callId}.`);
  return output.output;
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
