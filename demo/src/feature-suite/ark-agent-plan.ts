/**
 * Real Ark Agent Plan integration for the two OpenAI-compatible wire adapters.
 *
 * This executable intentionally keeps model requests small and bounded. Detailed recovery and
 * failure-path coverage lives in the deterministic offline suite; this file proves that the real
 * provider can complete Skill, summary, tool-result compact, and end-agent loops on both APIs.
 */
import {
  Agent,
  OpenAIChatModel,
  OpenAIResponsesModel,
  type ContextCompactOptions,
  type ModelGenerateRequest,
  type ModelGenerateResult,
  type OpenAIChatContext,
  type OpenAIChatProtocol,
  type OpenAIResponsesContext,
  type OpenAIResponsesProtocol,
  type SkillScriptExecutionResult,
  type ToolPayloadCompactInfo,
} from '@manee/agent-framework';
import { z } from 'zod';

import {
  assertFeature,
  loadArkAgentPlanConfiguration,
  logFeatureEvent,
  resolveDemoPath,
  sanitizeFailure,
  type ArkAgentPlanConfiguration,
} from './helpers';

const seedMarker = 'ARK_AGENT_PLAN_SEED_FACT_2026';
const summaryResultMarker = 'ARK_AGENT_PLAN_SUMMARY_RESULT_2026';
const proofToolName = 'emit-large-proof';
const proofPaddingChars = 20_000;
const compactedProofPrefix = '[feature-suite compacted proof]';
const expectedAgentToolSequence = [
  'skill',
  'skill',
  'skill',
  'skill',
  proofToolName,
  'end-agent',
] as const;
const maxProviderGenerateCalls = expectedAgentToolSequence.length + 1;
const providerRequestTimeoutMs = 120_000;

const inlineSkillName = 'inline-agent-plan-demo';
const inlineInstructionsMarker = 'INLINE_SKILL_INSTRUCTIONS';
const inlineLoadArgument = 'CHAT_LOAD_ARGUMENT';
const inlineReference = 'INLINE_REFERENCE_CONTENT';
const inlineAsset = 'INLINE_ASSET_CONTENT';

const fileSkillName = 'portable-demo';
const fileInstructionsMarker = 'PORTABLE_FILE_INSTRUCTIONS';
const fileLoadArgument = 'RESPONSES_LOAD_ARGUMENT';
const fileSkillPath = resolveDemoPath(import.meta.url, 'fixtures/skills/portable-demo');

interface RequestObservation<P extends OpenAIChatProtocol | OpenAIResponsesProtocol> {
  readonly request: ModelGenerateRequest<P>;
  /** Original provider response objects, retained in memory only for raw-history assertions. */
  readonly response: readonly P['context'][];
}

interface ScenarioEvidence {
  readonly proofPayload: string;
  readonly proofCalls: number;
  readonly compactedResultCalls: readonly string[];
  readonly calledTools: readonly string[];
}

class ObservedChatModel extends OpenAIChatModel {
  readonly observations: RequestObservation<OpenAIChatProtocol>[] = [];
  #generateCalls = 0;

  constructor(configuration: ArkAgentPlanConfiguration) {
    super({
      apiKey: configuration.apiKey,
      baseURL: configuration.baseURL,
      model: configuration.model,
      maxRetries: 0,
      timeout: providerRequestTimeoutMs,
    });
  }

  override async generate(
    request: ModelGenerateRequest<OpenAIChatProtocol>,
  ): Promise<ModelGenerateResult<OpenAIChatProtocol>> {
    this.#reserveGenerateCall();
    const result = await super.generate(request);

    this.observations.push(
      Object.freeze({
        request: freezeObservedRequest(request),
        response: Object.freeze([...result.messages]),
      }),
    );
    logFeatureEvent('chat', 'model', {
      purpose: request.purpose ?? 'agent',
      tools: request.tools.length,
      messages: result.messages.length,
      status: 'ok',
    });

    return result;
  }

  #reserveGenerateCall(): void {
    this.#generateCalls += 1;
    assertFeature(
      this.#generateCalls <= maxProviderGenerateCalls,
      `Chat exceeded the hard ${maxProviderGenerateCalls}-request provider budget.`,
    );
  }
}

class ObservedResponsesModel extends OpenAIResponsesModel {
  readonly observations: RequestObservation<OpenAIResponsesProtocol>[] = [];
  #generateCalls = 0;

  constructor(configuration: ArkAgentPlanConfiguration) {
    super({
      apiKey: configuration.apiKey,
      baseURL: configuration.baseURL,
      model: configuration.model,
      maxRetries: 0,
      timeout: providerRequestTimeoutMs,
    });
  }

  override async generate(
    request: ModelGenerateRequest<OpenAIResponsesProtocol>,
  ): Promise<ModelGenerateResult<OpenAIResponsesProtocol>> {
    this.#reserveGenerateCall();
    const result = await super.generate(request);

    this.observations.push(
      Object.freeze({
        request: freezeObservedRequest(request),
        response: Object.freeze([...result.messages]),
      }),
    );
    logFeatureEvent('responses', 'model', {
      purpose: request.purpose ?? 'agent',
      tools: request.tools.length,
      messages: result.messages.length,
      status: 'ok',
    });

    return result;
  }

  #reserveGenerateCall(): void {
    this.#generateCalls += 1;
    assertFeature(
      this.#generateCalls <= maxProviderGenerateCalls,
      `Responses exceeded the hard ${maxProviderGenerateCalls}-request provider budget.`,
    );
  }
}

async function runChatScenario(configuration: ArkAgentPlanConfiguration): Promise<void> {
  logFeatureEvent('chat', 'start');

  const model = new ObservedChatModel(configuration);
  const seedMessage: OpenAIChatContext = {
    role: 'user',
    content: `${seedMarker}: the integration must preserve this exact marker.\n${'archive '.repeat(240)}`,
  };
  const evidence = createScenarioEvidence('chat');
  const agent = new Agent<OpenAIChatProtocol>({
    llm: model,
    initContext: [seedMessage],
    initRawContext: [seedMessage],
    maxIterations: 10,
    modelErrorRecovery: {
      unhandledRetryLimit: 0,
      contextLengthRecoveryLimit: 0,
    },
    skills: [createInlineSkill()],
    skillRuntime: {
      scripts: {
        autoDetect: false,
        executors: {
          '.mjs': { command: process.execPath },
        },
      },
    },
    contextCompact: createCompactConfiguration(seedMessage, evidence.compactedResultCalls),
    systemPrompts: [
      buildScenarioPrompt({
        protocol: 'chat',
        skill: inlineSkillName,
        loadArgument: inlineLoadArgument,
      }),
    ],
  });

  installProofTool(agent, evidence, 'chat');
  observeToolNames(agent, evidence.calledTools, 'chat');
  agent.init();

  const activeContext = await agent.agent(
    'Execute the Chat Agent Plan feature-suite exactly as specified in the system prompt.',
  );

  assertChatScenario({ agent, model, activeContext, seedMessage, evidence });
}

async function runResponsesScenario(configuration: ArkAgentPlanConfiguration): Promise<void> {
  logFeatureEvent('responses', 'start');

  const model = new ObservedResponsesModel(configuration);
  const seedMessage: OpenAIResponsesContext = {
    role: 'user',
    content: [
      {
        type: 'input_text',
        text: `${seedMarker}: the integration must preserve this exact marker.\n${'archive '.repeat(240)}`,
      },
    ],
  };
  const evidence = createScenarioEvidence('responses');
  const agent = new Agent<OpenAIResponsesProtocol>({
    llm: model,
    initContext: [seedMessage],
    initRawContext: [seedMessage],
    maxIterations: 10,
    modelErrorRecovery: {
      unhandledRetryLimit: 0,
      contextLengthRecoveryLimit: 0,
    },
    skills: [{ source: 'file', path: fileSkillPath }],
    skillRuntime: {
      scripts: {
        autoDetect: false,
        executors: {
          '.mjs': { command: process.execPath },
        },
      },
    },
    contextCompact: createCompactConfiguration(seedMessage, evidence.compactedResultCalls),
    systemPrompts: [
      buildScenarioPrompt({
        protocol: 'responses',
        skill: fileSkillName,
        loadArgument: fileLoadArgument,
      }),
    ],
  });

  installProofTool(agent, evidence, 'responses');
  observeToolNames(agent, evidence.calledTools, 'responses');
  agent.init();
  assertFeature(
    agent.getSkillSourceDiagnostics().length === 0,
    'The portable file Skill must initialize without ignored-source diagnostics.',
  );

  const activeContext = await agent.agent(
    'Execute the Responses Agent Plan feature-suite exactly as specified in the system prompt.',
  );

  assertResponsesScenario({ agent, model, activeContext, seedMessage, evidence });
}

function createScenarioEvidence(protocol: 'chat' | 'responses'): {
  proofPayload: string;
  proofCalls: number;
  compactedResultCalls: string[];
  calledTools: string[];
} {
  return {
    proofPayload: JSON.stringify({
      protocol,
      marker: 'RAW_PROOF_PAYLOAD',
      padding: 'P'.repeat(proofPaddingChars),
    }),
    proofCalls: 0,
    compactedResultCalls: [],
    calledTools: [],
  };
}

function createInlineSkill() {
  return {
    name: inlineSkillName,
    description: 'Inline Skill used by the real Chat Agent Plan feature-suite.',
    instructions: `${inlineInstructionsMarker}\nUse the disclosed resources and script. Input: $ARGUMENTS`,
    references: {
      'guide.md': inlineReference,
    },
    assets: {
      'payload.txt': inlineAsset,
    },
    scripts: {
      inspect: {
        extension: '.mjs',
        description: 'Read both materialized resources and report argv without Shell parsing.',
        content: [
          "import { readFileSync } from 'node:fs';",
          "import { basename, resolve } from 'node:path';",
          "const guide = readFileSync(resolve(process.cwd(), 'references/guide.md'), 'utf8');",
          "const payload = readFileSync(resolve(process.cwd(), 'assets/payload.txt'), 'utf8');",
          'process.stdout.write(JSON.stringify({',
          '  argv: process.argv.slice(2),',
          '  guide,',
          '  payload,',
          '  cwdBase: basename(process.cwd()),',
          "}) + '\\n');",
        ].join('\n'),
      },
    },
  } as const;
}

function createCompactConfiguration<P extends OpenAIChatProtocol | OpenAIResponsesProtocol>(
  seedMessage: P['context'],
  compactedResultCalls: string[],
): ContextCompactOptions<P> {
  return {
    toolInput: false as const,
    toolResult: (original: string, info: ToolPayloadCompactInfo) => {
      compactedResultCalls.push(info.call.name);

      if (info.call.name !== proofToolName) {
        return undefined;
      }

      return JSON.stringify({
        compacted: true,
        marker: compactedProofPrefix,
        originalChars: original.length,
      });
    },
    summary: {
      trigger: ({ iteration, previousSummary }) => iteration === 0 && previousSummary === undefined,
      select: ({ activeContext }) => ({
        contextToSummarize: activeContext.filter((message) => message === seedMessage),
        preservedContext: activeContext.filter((message) => message !== seedMessage),
      }),
      prompt: () =>
        [
          'Summarize the supplied historical data in one short sentence.',
          `Preserve these exact tokens unchanged: ${seedMarker} ${summaryResultMarker}`,
        ].join(' '),
      validate: ({ summary }) =>
        summary.includes(seedMarker) && summary.includes(summaryResultMarker)
          ? { ok: true as const }
          : {
              ok: false as const,
              reason: 'Summary omitted one or more required feature-suite markers.',
            },
    },
  };
}

function installProofTool<P extends OpenAIChatProtocol | OpenAIResponsesProtocol>(
  agent: Agent<P>,
  evidence: { proofPayload: string; proofCalls: number },
  protocol: 'chat' | 'responses',
): void {
  agent.tools.push({
    name: proofToolName,
    description:
      'Emit the large proof payload once. The framework must preserve it in raw history and compact it in active context.',
    parameters: z.object({
      protocol: z.literal(protocol),
    }),
    handler: () => {
      evidence.proofCalls += 1;
      return evidence.proofPayload;
    },
  });
}

function observeToolNames<P extends OpenAIChatProtocol | OpenAIResponsesProtocol>(
  agent: Agent<P>,
  calledTools: string[],
  scenario: 'chat' | 'responses',
): void {
  for (const tool of ['skill', proofToolName, 'end-agent']) {
    agent.onBeforeToolCall(
      tool,
      () => {
        calledTools.push(tool);
        logFeatureEvent(scenario, 'tool', { tool });
      },
      { await: true },
    );
  }
}

function buildScenarioPrompt(input: {
  protocol: 'chat' | 'responses';
  skill: string;
  loadArgument: string;
}): string {
  return [
    `This is a strict ${input.protocol} integration test. Do not answer with prose and do not skip, repeat, rename, or combine steps.`,
    'Make exactly one tool call per model response and wait for its result before continuing.',
    `1. Call skill with {"skill":"${input.skill}","args":"load ${input.loadArgument}"}.`,
    `2. Call skill with {"skill":"${input.skill}","args":"read references/guide.md"}.`,
    `3. Call skill with {"skill":"${input.skill}","args":"read assets/payload.txt"}.`,
    `4. Call skill with {"skill":"${input.skill}","args":"run scripts/inspect.mjs 'argument with spaces' 'literal;$(no-shell)'"}.`,
    `5. Call ${proofToolName} with {"protocol":"${input.protocol}"}.`,
    '6. After observing its compacted result, call end-agent by itself.',
  ].join('\n');
}

function assertChatScenario(input: {
  readonly agent: Agent<OpenAIChatProtocol>;
  readonly model: ObservedChatModel;
  readonly activeContext: readonly OpenAIChatContext[];
  readonly seedMessage: OpenAIChatContext;
  readonly evidence: ScenarioEvidence;
}): void {
  assertRequestObservations({
    observations: input.model.observations,
    readText: readChatText,
    parseCalls: (context) => input.model.parseToolCalls(context),
    parseOutputs: (context) =>
      input.model.parseToolCallOutputMessages(context).map(({ message }) => message),
    evidence: input.evidence,
  });
  assertFeature(input.evidence.proofCalls === 1, 'Chat must call the proof tool exactly once.');

  const history = input.agent.getHistory();
  const calls = input.model.parseToolCalls(history);
  const outputs = input.model.parseToolCallOutputMessages(history);
  const activeOutputs = input.model.parseToolCallOutputMessages(input.activeContext);

  assertToolLoop(calls, input.evidence.calledTools, inlineSkillName);
  assertPayloadCompaction({
    calls,
    rawOutputs: outputs,
    activeOutputs,
    evidence: input.evidence,
  });
  assertFeature(
    findOutputForCallName(calls, outputs, 'end-agent').length > 0,
    'Chat end-agent must complete its tool-result closure.',
  );
  assertSkillOutputs({
    calls,
    rawOutputs: outputs,
    activeOutputs,
    skillName: inlineSkillName,
    instructionsMarker: inlineInstructionsMarker,
    loadArgument: inlineLoadArgument,
    referenceMarker: inlineReference,
    assetMarker: inlineAsset,
  });
  assertSummaryCommit(
    history,
    input.activeContext,
    input.seedMessage,
    input.model.observations,
    readChatText,
  );

  const rawProofChars = input.evidence.proofPayload.length;
  const activeProofChars = findOutputForCallName(calls, activeOutputs, proofToolName).length;
  logFeatureEvent('chat', 'passed', {
    status: 'ok',
    rawChars: rawProofChars,
    activeChars: activeProofChars,
    messages: input.activeContext.length,
  });
}

function assertResponsesScenario(input: {
  readonly agent: Agent<OpenAIResponsesProtocol>;
  readonly model: ObservedResponsesModel;
  readonly activeContext: readonly OpenAIResponsesContext[];
  readonly seedMessage: OpenAIResponsesContext;
  readonly evidence: ScenarioEvidence;
}): void {
  assertRequestObservations({
    observations: input.model.observations,
    readText: readResponsesText,
    parseCalls: (context) => input.model.parseToolCalls(context),
    parseOutputs: (context) =>
      normalizeResponsesOutputs(input.model.parseToolCallOutputMessages(context)).map(
        ({ message }) => message,
      ),
    evidence: input.evidence,
  });
  assertFeature(
    input.evidence.proofCalls === 1,
    'Responses must call the proof tool exactly once.',
  );

  const history = input.agent.getHistory();
  const calls = input.model.parseToolCalls(history);
  const outputs = input.model.parseToolCallOutputMessages(history);
  const activeOutputs = input.model.parseToolCallOutputMessages(input.activeContext);
  const normalizedOutputs = normalizeResponsesOutputs(outputs);
  const normalizedActiveOutputs = normalizeResponsesOutputs(activeOutputs);

  assertToolLoop(calls, input.evidence.calledTools, fileSkillName);
  assertPayloadCompaction({
    calls,
    rawOutputs: normalizedOutputs,
    activeOutputs: normalizedActiveOutputs,
    evidence: input.evidence,
  });
  assertFeature(
    findOutputForCallName(calls, normalizedOutputs, 'end-agent').length > 0,
    'Responses end-agent must complete its tool-result closure.',
  );
  assertSkillOutputs({
    calls,
    rawOutputs: normalizedOutputs,
    activeOutputs: normalizedActiveOutputs,
    skillName: fileSkillName,
    instructionsMarker: fileInstructionsMarker,
    loadArgument: fileLoadArgument,
  });
  assertSummaryCommit(
    history,
    input.activeContext,
    input.seedMessage,
    input.model.observations,
    readResponsesText,
  );

  const rawProofChars = input.evidence.proofPayload.length;
  const activeProofChars = findOutputForCallName(
    calls,
    normalizedActiveOutputs,
    proofToolName,
  ).length;
  logFeatureEvent('responses', 'passed', {
    status: 'ok',
    rawChars: rawProofChars,
    activeChars: activeProofChars,
    messages: input.activeContext.length,
  });
}

function assertRequestObservations<P extends OpenAIChatProtocol | OpenAIResponsesProtocol>(input: {
  readonly observations: readonly RequestObservation<P>[];
  readonly readText: (message: P['context']) => string;
  readonly parseCalls: (
    context: readonly P['context'][],
  ) => readonly { id: string; name: string }[];
  readonly parseOutputs: (
    context: readonly P['context'][],
  ) => readonly { callId: string; output: string }[];
  readonly evidence: ScenarioEvidence;
}): void {
  const summaryRequests = input.observations.filter(
    ({ request }) => request.purpose === 'context-summary',
  );
  const agentRequests = input.observations.filter(({ request }) => request.purpose === undefined);

  assertFeature(
    input.observations.length === maxProviderGenerateCalls,
    `Expected exactly ${maxProviderGenerateCalls} successful provider requests.`,
  );
  assertFeature(
    input.observations.every(
      ({ request }) => request.purpose === undefined || request.purpose === 'context-summary',
    ),
    'Normal Agent requests must omit purpose instead of setting purpose=agent.',
  );
  assertFeature(
    summaryRequests.length === 1,
    'Expected exactly one real proactive summary request.',
  );
  assertFeature(
    summaryRequests[0]?.request.tools.length === 0,
    'Summary request must expose no tools.',
  );
  assertFeature(
    summaryRequests[0] !== undefined && input.parseCalls(summaryRequests[0].response).length === 0,
    'Summary response must not contain a tool call.',
  );
  assertFeature(
    agentRequests.length === expectedAgentToolSequence.length,
    `Expected exactly ${expectedAgentToolSequence.length} normal Agent requests.`,
  );
  assertFeature(
    agentRequests.every(({ request }) => request.tools.length > 0),
    'Normal Agent requests must expose the tool catalog.',
  );
  assertFeature(
    agentRequests.some(({ request }) =>
      request.context.some((message) => {
        const text = input.readText(message);
        return (
          text.includes('[Framework-generated summary of earlier context') &&
          text.includes(seedMarker) &&
          text.includes(summaryResultMarker)
        );
      }),
    ),
    'A normal request must consume the committed summary containing the seed marker.',
  );

  const responseCalls = agentRequests.map((observation, index) => {
    const calls = input.parseCalls(observation.response);
    assertFeature(
      calls.length === 1,
      `Normal provider response ${index + 1} must contain exactly one tool call.`,
    );
    assertFeature(
      calls[0]?.name === expectedAgentToolSequence[index],
      `Normal provider response ${index + 1} called an unexpected tool.`,
    );
    assertFeature(
      observation.response.every((message) => input.readText(message).trim().length === 0),
      `Normal provider response ${index + 1} must not include assistant prose.`,
    );
    return calls[0];
  });

  for (let index = 1; index < agentRequests.length; index += 1) {
    const previousCall = responseCalls[index - 1];
    assertFeature(previousCall !== undefined, 'Missing the previous provider tool call.');
    const requestOutputs = input.parseOutputs(agentRequests[index]?.request.context ?? []);
    assertFeature(
      requestOutputs.some(({ callId }) => callId === previousCall.id),
      `Normal request ${index + 1} must consume the preceding tool result.`,
    );
  }

  const endRequest = agentRequests.at(-1);
  assertFeature(endRequest !== undefined, 'Missing the end-agent provider request.');
  const proofCall = responseCalls.at(-2);
  assertFeature(
    proofCall?.name === proofToolName,
    'The request before end-agent must be the proof tool call.',
  );
  const endRequestOutputs = input.parseOutputs(endRequest.request.context);
  const proofOutputSeenByEnd = endRequestOutputs.find(
    ({ callId }) => callId === proofCall.id,
  )?.output;
  assertFeature(
    proofOutputSeenByEnd?.includes(compactedProofPrefix) === true,
    'The end-agent request must observe the compacted proof result.',
  );
  assertFeature(
    proofOutputSeenByEnd !== input.evidence.proofPayload,
    'The end-agent request must not receive the raw 20K proof result.',
  );
}

function assertToolLoop(
  calls: readonly { name: string; sourceMessage: unknown }[],
  observedToolNames: readonly string[],
  expectedSkillName: string,
): void {
  const skillCalls = calls.filter((call) => call.name === 'skill');
  const proofCalls = calls.filter((call) => call.name === proofToolName);
  const endCalls = calls.filter((call) => call.name === 'end-agent');

  assertFeature(
    skillCalls.length === 4,
    `Expected four progressive calls for ${expectedSkillName}.`,
  );
  assertFeature(proofCalls.length === 1, 'Expected one proof tool wire call.');
  assertFeature(endCalls.length === 1, 'Expected one end-agent wire call.');
  assertFeature(
    JSON.stringify(calls.map(({ name }) => name)) === JSON.stringify(expectedAgentToolSequence),
    'Raw provider history must contain exactly the strict Skill/proof/end tool sequence.',
  );
  assertFeature(
    observedToolNames.filter((name) => name === 'skill').length === 4,
    'All four Skill calls must execute through the built-in runtime tool.',
  );
  assertFeature(
    JSON.stringify(observedToolNames) === JSON.stringify(expectedAgentToolSequence),
    'The provider must execute the strict Skill/proof/end sequence without repeats.',
  );
  assertFeature(
    calls.filter((call) => call.sourceMessage === endCalls[0]?.sourceMessage).length === 1,
    'end-agent must be the only tool call in its model response.',
  );
}

function assertPayloadCompaction(input: {
  readonly calls: readonly { id: string; name: string }[];
  readonly rawOutputs: readonly { message: { callId: string; output: string } }[];
  readonly activeOutputs: readonly { message: { callId: string; output: string } }[];
  readonly evidence: ScenarioEvidence;
}): void {
  const rawProof = findOutputForCallName(input.calls, input.rawOutputs, proofToolName);
  const activeProof = findOutputForCallName(input.calls, input.activeOutputs, proofToolName);

  assertFeature(
    rawProof === input.evidence.proofPayload,
    'Raw history must retain exact proof output.',
  );
  assertFeature(
    activeProof.includes(compactedProofPrefix) && activeProof !== rawProof,
    'Active context must contain the custom compacted proof marker.',
  );
  assertFeature(
    activeProof.length < rawProof.length,
    'Compacted proof output must be shorter than its raw counterpart.',
  );
  assertFeature(
    input.evidence.compactedResultCalls.includes(proofToolName),
    'The normal proof tool must invoke the result compactor.',
  );
  assertFeature(
    !input.evidence.compactedResultCalls.includes('skill'),
    'The actual built-in Skill tool must skip result compaction by default.',
  );
}

function assertSkillOutputs(input: {
  readonly calls: readonly { id: string; name: string; arguments: string }[];
  readonly rawOutputs: readonly { message: { callId: string; output: string } }[];
  readonly activeOutputs: readonly { message: { callId: string; output: string } }[];
  readonly skillName: string;
  readonly instructionsMarker: string;
  readonly loadArgument: string;
  readonly referenceMarker?: string;
  readonly assetMarker?: string;
}): void {
  const commands = input.calls
    .filter((call) => call.name === 'skill')
    .map((call) => {
      const parameters = JSON.parse(call.arguments) as { skill?: unknown; args?: unknown };
      assertFeature(parameters.skill === input.skillName, 'Skill call selected the wrong Skill.');
      assertFeature(typeof parameters.args === 'string', 'Skill command args must be a string.');

      return {
        call,
        args: parameters.args,
        raw: findOutput(input.rawOutputs, call.id),
        active: findOutput(input.activeOutputs, call.id),
      };
    });

  for (const command of commands) {
    assertFeature(
      command.raw === command.active,
      'Every built-in Skill output must remain byte-identical in active and raw context.',
    );
  }

  const load = commands.find(({ args }) => args.startsWith('load '));
  const reference = commands.find(({ args }) => args === 'read references/guide.md');
  const asset = commands.find(({ args }) => args === 'read assets/payload.txt');
  const run = commands.find(({ args }) => args.startsWith('run scripts/inspect.mjs '));

  assertFeature(load !== undefined, 'Expected the Skill load command.');
  assertFeature(reference !== undefined, 'Expected the Skill reference read command.');
  assertFeature(asset !== undefined, 'Expected the Skill asset read command.');
  assertFeature(run !== undefined, 'Expected the Skill run command.');
  assertFeature(
    load.raw.includes(input.instructionsMarker),
    'Skill load lost its instruction marker.',
  );
  assertFeature(load.raw.includes(input.loadArgument), 'Skill load lost its rendered argument.');

  if (input.referenceMarker !== undefined) {
    assertFeature(reference.raw === input.referenceMarker, 'Inline reference content changed.');
  } else {
    assertFeature(reference.raw.length > 0, 'File Skill reference must not be empty.');
  }

  if (input.assetMarker !== undefined) {
    assertFeature(asset.raw === input.assetMarker, 'Inline asset content changed.');
  } else {
    assertFeature(asset.raw.length > 0, 'File Skill asset must not be empty.');
  }

  const execution = JSON.parse(run.raw) as SkillScriptExecutionResult;
  assertFeature(execution.exitCode === 0, 'Skill script must exit successfully.');
  assertFeature(execution.signal === null, 'Skill script must not receive a signal.');
  assertFeature(execution.stderr === '', 'Skill script must not write stderr.');

  const stdout = JSON.parse(execution.stdout.trim()) as {
    argv?: unknown;
    guide?: unknown;
    payload?: unknown;
    cwdBase?: unknown;
  };
  assertFeature(
    JSON.stringify(stdout.argv) === JSON.stringify(['argument with spaces', 'literal;$(no-shell)']),
    'Skill argv must arrive literally without Shell interpretation.',
  );
  assertFeature(
    stdout.guide === reference.raw.trim(),
    'Skill script must read the registered reference.',
  );
  assertFeature(
    stdout.payload === asset.raw.trim(),
    'Skill script must read the registered asset.',
  );
  assertFeature(stdout.cwdBase === input.skillName, 'Skill script cwd must be the Skill root.');
}

function assertSummaryCommit<P extends OpenAIChatProtocol | OpenAIResponsesProtocol>(
  history: readonly P['context'][],
  activeContext: readonly P['context'][],
  seedMessage: P['context'],
  observations: readonly RequestObservation<P>[],
  readText: (message: P['context']) => string,
): void {
  assertFeature(history.includes(seedMessage), 'Raw history must retain the exact seed message.');
  assertFeature(
    !activeContext.includes(seedMessage),
    'Summary commit must replace, not retain, the original seed in active context.',
  );

  const summaryObservation = observations.find(
    ({ request }) => request.purpose === 'context-summary',
  );
  assertFeature(summaryObservation !== undefined, 'Missing the successful summary observation.');
  assertFeature(summaryObservation.response.length > 0, 'Summary response must not be empty.');

  for (const responseMessage of summaryObservation.response) {
    assertFeature(
      !history.includes(responseMessage),
      'Original provider summary response objects must never enter raw history.',
    );
  }

  const summaryResponseTexts = summaryObservation.response
    .map((message) => readText(message).trim())
    .filter((text) => text.length > 0);
  assertFeature(summaryResponseTexts.length > 0, 'Summary response must contain assistant text.');
  assertFeature(
    !history.some((message) =>
      readText(message).includes('[Framework-generated summary of earlier'),
    ),
    'Synthetic summary must not be written to raw history.',
  );
  assertFeature(
    history.every((message) => !readText(message).includes(summaryResultMarker)),
    'Summary-response-only text must not be written to raw history.',
  );
  assertFeature(
    activeContext.some((message) => {
      const text = readText(message);
      return (
        text.includes('[Framework-generated summary of earlier') &&
        text.includes(seedMarker) &&
        text.includes(summaryResultMarker) &&
        summaryResponseTexts.some((summaryText) => text.includes(summaryText))
      );
    }),
    'Active context must contain the committed synthetic summary response and both markers.',
  );
}

function findOutputForCallName(
  calls: readonly { id: string; name: string }[],
  outputs: readonly { message: { callId: string; output: string } }[],
  name: string,
): string {
  const call = calls.find((candidate) => candidate.name === name);
  assertFeature(call !== undefined, `Missing tool call ${name}.`);
  return findOutput(outputs, call.id);
}

function findOutput(
  outputs: readonly { message: { callId: string; output: string } }[],
  callId: string,
): string {
  const output = outputs.find(({ message }) => message.callId === callId)?.message.output;
  assertFeature(output !== undefined, `Missing tool output for call ${callId}.`);
  return output;
}

function normalizeResponsesOutputs(
  outputs: ReturnType<ObservedResponsesModel['parseToolCallOutputMessages']>,
): readonly { message: { callId: string; output: string } }[] {
  return outputs.map(({ message }) => {
    assertFeature(
      typeof message.output === 'string',
      'Framework-generated Responses tool output must use the string wire representation.',
    );

    return {
      message: {
        callId: message.callId,
        output: message.output,
      },
    };
  });
}

function readChatText(message: OpenAIChatContext): string {
  if (!('content' in message)) {
    return '';
  }

  if (typeof message.content === 'string') {
    return message.content;
  }

  if (!Array.isArray(message.content)) {
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

function readResponsesText(message: OpenAIResponsesContext): string {
  if (!('content' in message) || !Array.isArray(message.content)) {
    return '';
  }

  return message.content
    .flatMap((part) => {
      if ('text' in part && typeof part.text === 'string') {
        return [part.text];
      }

      if ('refusal' in part && typeof part.refusal === 'string') {
        return [part.refusal];
      }

      return [];
    })
    .join('\n');
}

function freezeObservedRequest<P extends OpenAIChatProtocol | OpenAIResponsesProtocol>(
  request: ModelGenerateRequest<P>,
): ModelGenerateRequest<P> {
  return Object.freeze({
    ...request,
    context: Object.freeze([...request.context]),
    tools: Object.freeze([...request.tools]),
  });
}

class ArkFeatureSuiteError extends AggregateError {
  readonly code = 'ark_feature_suite_failed';

  constructor(errors: readonly unknown[]) {
    super(errors, `${errors.length} Ark Agent Plan scenario(s) failed.`);
    this.name = 'ArkFeatureSuiteError';
  }
}

async function runSuite(): Promise<void> {
  const configuration = loadArkAgentPlanConfiguration(import.meta.url);
  const failures: unknown[] = [];

  for (const scenario of [
    { name: 'chat' as const, run: runChatScenario },
    { name: 'responses' as const, run: runResponsesScenario },
  ]) {
    try {
      await scenario.run(configuration);
    } catch (error) {
      failures.push(error);
      const failure = sanitizeFailure(error);
      logFeatureEvent(scenario.name, 'failed', {
        ...(failure.status === undefined ? {} : { status: failure.status }),
        code: failure.code ?? failure.name,
        errorType: failure.type ?? failure.name,
      });
    }
  }

  if (failures.length > 0) {
    throw new ArkFeatureSuiteError(failures);
  }

  logFeatureEvent('suite', 'passed', { status: 'ok', failedScenarios: 0 });
}

try {
  await runSuite();
} catch (error) {
  const failure = sanitizeFailure(error);
  logFeatureEvent('suite', 'failed', {
    ...(failure.status === undefined ? {} : { status: failure.status }),
    code: failure.code ?? failure.name,
    errorType: failure.type ?? failure.name,
    ...(error instanceof AggregateError ? { failedScenarios: error.errors.length } : {}),
  });
  process.exitCode = 1;
}
