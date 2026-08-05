/**
 * Real Ark Agent Plan integration for the two OpenAI-compatible wire adapters.
 *
 * The executable keeps provider calls bounded while proving progressive Skills, decorated and
 * runtime tools, nested sub-agents, active-only input/result compaction, real summary generation,
 * raw-history preservation, tool events, and end-agent closure on both APIs.
 */
import {
  Agent,
  OpenAIChatModel,
  OpenAIResponsesModel,
  Tool,
  type AgentOptions,
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
const decoratedToolName = 'capture-decorated-input';
const decoratedInputPrefix = 'DECORATED_TOOL_INPUT';
const compactedInputPrefix = '[feature-suite compacted input]';
const decoratedResultMarker = 'DECORATED_TOOL_RESULT_OK';
const proofToolName = 'emit-large-proof';
const subAgentProofToolName = 'build-subagent-proof';
const subAgentResultToolName = 'agent-result';
const subAgentProofPrefix = 'SUBAGENT_PROOF';
const proofPaddingChars = 20_000;
const compactedProofPrefix = '[feature-suite compacted proof]';
const expectedParentToolSequence = [
  'skill',
  'skill',
  'skill',
  'skill',
  decoratedToolName,
  proofToolName,
  'agent',
  'end-agent',
] as const;
const expectedSubAgentToolSequence = [
  subAgentProofToolName,
  subAgentResultToolName,
  'end-agent',
] as const;
const maxProviderGenerateCalls =
  expectedParentToolSequence.length + expectedSubAgentToolSequence.length + 1;
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
  readonly decoratedInputPayload: string;
  readonly proofCalls: number;
  readonly decoratedToolCalls: number;
  readonly decoratedHandlerPayloads: readonly string[];
  readonly compactedInputCalls: readonly string[];
  readonly compactedResultCalls: readonly string[];
  readonly calledTools: readonly string[];
  readonly completedTools: readonly string[];
  readonly subAgentCalledTools: readonly string[];
  readonly subAgentCompletedTools: readonly string[];
  readonly subAgentProofs: readonly string[];
  readonly parentSubAgentResults: readonly string[];
}

type MutableScenarioEvidence = {
  -readonly [K in keyof ScenarioEvidence]: ScenarioEvidence[K] extends readonly (infer Item)[]
    ? Item[]
    : ScenarioEvidence[K];
};

const activeScenarioEvidence: Partial<Record<'chat' | 'responses', MutableScenarioEvidence>> = {};

class ObservedChatModel extends OpenAIChatModel {
  readonly observations: RequestObservation<OpenAIChatProtocol>[] = [];
  #generateCalls = 0;
  readonly #sequence = { parent: 0, subAgent: 0 };

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
    validateLiveModelResponse({
      request,
      response: result.messages,
      parseCalls: (context) => this.parseToolCalls(context),
      readText: readChatText,
      sequence: this.#sequence,
      scenario: 'chat',
    });

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
  readonly #sequence = { parent: 0, subAgent: 0 };

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
    validateLiveModelResponse({
      request,
      response: result.messages,
      parseCalls: (context) => this.parseToolCalls(context),
      readText: readResponsesText,
      sequence: this.#sequence,
      scenario: 'responses',
    });

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

class ChatFeatureAgent extends Agent<OpenAIChatProtocol> {
  @Tool({
    name: decoratedToolName,
    description:
      'Accept a marked long input payload. This decorated tool proves schema validation and tool-input compaction.',
    parameters: z.object({
      payload: z.string().min(256),
    }),
    strict: true,
  })
  #captureDecoratedInput(parameters: unknown): Record<string, unknown> {
    return captureDecoratedInput('chat', parameters);
  }
}

class ResponsesFeatureAgent extends Agent<OpenAIResponsesProtocol> {
  @Tool({
    name: decoratedToolName,
    description:
      'Accept a marked long input payload. This decorated tool proves schema validation and tool-input compaction.',
    parameters: z.object({
      payload: z.string().min(256),
    }),
    strict: true,
  })
  #captureDecoratedInput(parameters: unknown): Record<string, unknown> {
    return captureDecoratedInput('responses', parameters);
  }
}

class ChatFeatureVerifierAgent extends Agent<OpenAIChatProtocol> {
  static override name = 'chat-feature-verifier';
  static override description = 'Verifies nested Chat sub-agent dispatch and result reporting.';

  constructor(options: AgentOptions<OpenAIChatProtocol>) {
    super({
      ...options,
      maxIterations: 6,
      modelErrorRecovery: {
        unhandledRetryLimit: 0,
        contextLengthRecoveryLimit: 0,
      },
      systemPrompts: [...(options.systemPrompts ?? []), buildSubAgentPrompt('chat')],
    });
    observeSubAgentToolNames(this, requireScenarioEvidence('chat'), 'chat');
  }

  @Tool({
    name: subAgentProofToolName,
    description: 'Build the deterministic proof that the Chat parent must receive.',
    parameters: z.object({
      label: z.string().min(1),
      numbers: z.array(z.number()).min(1),
    }),
  })
  #buildSubAgentProof(parameters: unknown): Record<string, unknown> {
    return buildSubAgentProof('chat', parameters);
  }
}

class ResponsesFeatureVerifierAgent extends Agent<OpenAIResponsesProtocol> {
  static override name = 'responses-feature-verifier';
  static override description =
    'Verifies nested Responses sub-agent dispatch and result reporting.';

  constructor(options: AgentOptions<OpenAIResponsesProtocol>) {
    super({
      ...options,
      maxIterations: 6,
      modelErrorRecovery: {
        unhandledRetryLimit: 0,
        contextLengthRecoveryLimit: 0,
      },
      systemPrompts: [...(options.systemPrompts ?? []), buildSubAgentPrompt('responses')],
    });
    observeSubAgentToolNames(this, requireScenarioEvidence('responses'), 'responses');
  }

  @Tool({
    name: subAgentProofToolName,
    description: 'Build the deterministic proof that the Responses parent must receive.',
    parameters: z.object({
      label: z.string().min(1),
      numbers: z.array(z.number()).min(1),
    }),
  })
  #buildSubAgentProof(parameters: unknown): Record<string, unknown> {
    return buildSubAgentProof('responses', parameters);
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
  activeScenarioEvidence.chat = evidence;
  const agent = new ChatFeatureAgent({
    llm: model,
    initContext: [seedMessage],
    initRawContext: [seedMessage],
    maxIterations: 10,
    modelErrorRecovery: {
      unhandledRetryLimit: 0,
      contextLengthRecoveryLimit: 0,
    },
    skills: [createInlineSkill()],
    subAgents: [ChatFeatureVerifierAgent],
    skillRuntime: {
      scripts: {
        autoDetect: false,
        executors: {
          '.mjs': { command: process.execPath },
        },
      },
    },
    contextCompact: createCompactConfiguration(seedMessage, evidence),
    systemPrompts: [
      buildScenarioPrompt({
        protocol: 'chat',
        skill: inlineSkillName,
        loadArgument: inlineLoadArgument,
      }),
    ],
  });

  installProofTool(agent, evidence);
  observeToolNames(agent, evidence, 'chat');
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
  activeScenarioEvidence.responses = evidence;
  const agent = new ResponsesFeatureAgent({
    llm: model,
    initContext: [seedMessage],
    initRawContext: [seedMessage],
    maxIterations: 10,
    modelErrorRecovery: {
      unhandledRetryLimit: 0,
      contextLengthRecoveryLimit: 0,
    },
    skills: [{ source: 'file', path: fileSkillPath }],
    subAgents: [ResponsesFeatureVerifierAgent],
    skillRuntime: {
      scripts: {
        autoDetect: false,
        executors: {
          '.mjs': { command: process.execPath },
        },
      },
    },
    contextCompact: createCompactConfiguration(seedMessage, evidence),
    systemPrompts: [
      buildScenarioPrompt({
        protocol: 'responses',
        skill: fileSkillName,
        loadArgument: fileLoadArgument,
      }),
    ],
  });

  installProofTool(agent, evidence);
  observeToolNames(agent, evidence, 'responses');
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
  decoratedInputPayload: string;
  proofCalls: number;
  decoratedToolCalls: number;
  decoratedHandlerPayloads: string[];
  compactedInputCalls: string[];
  compactedResultCalls: string[];
  calledTools: string[];
  completedTools: string[];
  subAgentCalledTools: string[];
  subAgentCompletedTools: string[];
  subAgentProofs: string[];
  parentSubAgentResults: string[];
} {
  return {
    proofPayload: JSON.stringify({
      protocol,
      marker: 'RAW_PROOF_PAYLOAD',
      padding: 'P'.repeat(proofPaddingChars),
    }),
    decoratedInputPayload: `${decoratedInputPrefix}::${protocol}::${'I'.repeat(512)}`,
    proofCalls: 0,
    decoratedToolCalls: 0,
    decoratedHandlerPayloads: [],
    compactedInputCalls: [],
    compactedResultCalls: [],
    calledTools: [],
    completedTools: [],
    subAgentCalledTools: [],
    subAgentCompletedTools: [],
    subAgentProofs: [],
    parentSubAgentResults: [],
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
  evidence: MutableScenarioEvidence,
): ContextCompactOptions<P> {
  return {
    toolInput: (original: string, info: ToolPayloadCompactInfo) => {
      evidence.compactedInputCalls.push(info.call.name);

      if (info.call.name !== decoratedToolName) {
        return undefined;
      }

      return JSON.stringify({
        compacted: true,
        marker: compactedInputPrefix,
        originalChars: original.length,
      });
    },
    toolResult: (original: string, info: ToolPayloadCompactInfo) => {
      evidence.compactedResultCalls.push(info.call.name);

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
): void {
  agent.tools.push({
    name: proofToolName,
    description:
      'Emit the large proof payload once. The framework must preserve it in raw history and compact it in active context.',
    parameters: z.object({}),
    strict: true,
    handler: () => {
      evidence.proofCalls += 1;
      return evidence.proofPayload;
    },
  });
}

function observeToolNames<P extends OpenAIChatProtocol | OpenAIResponsesProtocol>(
  agent: Agent<P>,
  evidence: MutableScenarioEvidence,
  scenario: 'chat' | 'responses',
): void {
  for (const tool of new Set(expectedParentToolSequence)) {
    agent.onBeforeToolCall(
      tool,
      () => {
        evidence.calledTools.push(tool);
        logFeatureEvent(scenario, 'tool', { tool });
      },
      { await: true },
    );
    agent.onAfterToolCall(
      tool,
      (_parameters, _call, result) => {
        evidence.completedTools.push(tool);
        if (tool === 'agent') {
          evidence.parentSubAgentResults.push(String(result));
        }
      },
      { await: true },
    );
  }
}

function observeSubAgentToolNames<P extends OpenAIChatProtocol | OpenAIResponsesProtocol>(
  agent: Agent<P>,
  evidence: MutableScenarioEvidence,
  scenario: 'chat' | 'responses',
): void {
  for (const tool of expectedSubAgentToolSequence) {
    agent.onBeforeToolCall(
      tool,
      () => {
        evidence.subAgentCalledTools.push(tool);
        logFeatureEvent(scenario, 'tool', { tool });
      },
      { await: true },
    );
    agent.onAfterToolCall(
      tool,
      () => {
        evidence.subAgentCompletedTools.push(tool);
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
    `5. Call ${decoratedToolName} with ${JSON.stringify({
      payload: requireScenarioEvidence(input.protocol).decoratedInputPayload,
    })}.`,
    `6. Call ${proofToolName} with {}.`,
    `7. Call agent with ${JSON.stringify({
      agentName: `${input.protocol}-feature-verifier`,
      input:
        'Call build-subagent-proof with label feature-suite and numbers [2,3,5], then report the exact proof marker.',
      outputDescription: `Exactly ${expectedSubAgentProof(input.protocol)}`,
    })}.`,
    '8. After observing the sub-agent result, call end-agent by itself.',
  ].join('\n');
}

function buildSubAgentPrompt(protocol: 'chat' | 'responses'): string {
  return [
    `This is the isolated ${protocol} verifier. Make exactly one tool call per response and output no prose.`,
    `1. Call ${subAgentProofToolName} with {"label":"feature-suite","numbers":[2,3,5]}.`,
    `2. Call ${subAgentResultToolName} with {"result":"${expectedSubAgentProof(protocol)}"}.`,
    '3. Call end-agent by itself.',
  ].join('\n');
}

function captureDecoratedInput(
  protocol: 'chat' | 'responses',
  parameters: unknown,
): Record<string, unknown> {
  const { payload } = parameters as { payload: string };
  const evidence = requireScenarioEvidence(protocol);

  assertFeature(
    payload.startsWith(`${decoratedInputPrefix}::${protocol}::`) && payload.length >= 256,
    `${protocol} decorated tool must receive the marked long input payload.`,
  );
  evidence.decoratedToolCalls += 1;
  evidence.decoratedHandlerPayloads.push(payload);

  return {
    accepted: true,
    marker: decoratedResultMarker,
    protocol,
    payloadChars: payload.length,
  };
}

function buildSubAgentProof(
  protocol: 'chat' | 'responses',
  parameters: unknown,
): Record<string, unknown> {
  const { label, numbers } = parameters as { label: string; numbers: number[] };
  assertFeature(
    label === 'feature-suite' && JSON.stringify(numbers) === JSON.stringify([2, 3, 5]),
    'Sub-agent proof tool received changed parameters.',
  );
  const sum = numbers.reduce((total, value) => total + value, 0);
  const proof = `${subAgentProofPrefix}::${protocol}::${label}::${sum}`;

  assertFeature(proof === expectedSubAgentProof(protocol), 'Sub-agent proof parameters changed.');
  requireScenarioEvidence(protocol).subAgentProofs.push(proof);

  return { protocol, label, sum, proof };
}

function expectedSubAgentProof(protocol: 'chat' | 'responses'): string {
  return `${subAgentProofPrefix}::${protocol}::feature-suite::10`;
}

function requireScenarioEvidence(protocol: 'chat' | 'responses'): MutableScenarioEvidence {
  const evidence = activeScenarioEvidence[protocol];
  assertFeature(evidence !== undefined, `Missing active ${protocol} scenario evidence.`);
  return evidence;
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
  const activeCalls = input.model.parseToolCalls(input.activeContext);
  const outputs = input.model.parseToolCallOutputMessages(history);
  const activeOutputs = input.model.parseToolCallOutputMessages(input.activeContext);

  assertToolLoop(calls, input.evidence, inlineSkillName, 'chat');
  assertPayloadCompaction({
    rawCalls: calls,
    activeCalls,
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
  const activeCalls = input.model.parseToolCalls(input.activeContext);
  const outputs = input.model.parseToolCallOutputMessages(history);
  const activeOutputs = input.model.parseToolCallOutputMessages(input.activeContext);
  const normalizedOutputs = normalizeResponsesOutputs(outputs);
  const normalizedActiveOutputs = normalizeResponsesOutputs(activeOutputs);

  assertToolLoop(calls, input.evidence, fileSkillName, 'responses');
  assertPayloadCompaction({
    rawCalls: calls,
    activeCalls,
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

function validateLiveModelResponse<P extends OpenAIChatProtocol | OpenAIResponsesProtocol>(input: {
  readonly request: ModelGenerateRequest<P>;
  readonly response: readonly P['context'][];
  readonly parseCalls: (context: readonly P['context'][]) => readonly { name: string }[];
  readonly readText: (message: P['context']) => string;
  readonly sequence: { parent: number; subAgent: number };
  readonly scenario: 'chat' | 'responses';
}): void {
  const calls = input.parseCalls(input.response);
  if (input.request.purpose === 'context-summary') {
    assertFeature(calls.length === 0, `${input.scenario} summary returned a tool call.`);
    return;
  }

  assertFeature(
    input.request.purpose === undefined,
    `${input.scenario} returned an unsupported model request purpose.`,
  );
  const isSubAgent = input.request.tools.some(
    (tool) => readRequestToolName(tool) === subAgentResultToolName,
  );
  const expectedSequence = isSubAgent ? expectedSubAgentToolSequence : expectedParentToolSequence;
  const index = isSubAgent ? input.sequence.subAgent : input.sequence.parent;

  assertFeature(
    index < expectedSequence.length,
    `${input.scenario} generated an extra ${isSubAgent ? 'sub-agent' : 'parent'} step.`,
  );
  assertFeature(
    calls.length === 1,
    `${input.scenario} ${isSubAgent ? 'sub-agent' : 'parent'} response must call one tool.`,
  );
  assertFeature(
    calls[0]?.name === expectedSequence[index],
    `${input.scenario} ${isSubAgent ? 'sub-agent' : 'parent'} response expected ${expectedSequence[index]} but received ${calls[0]?.name ?? 'no tool'}.`,
  );
  assertFeature(
    input.response.every((message) => input.readText(message).trim().length === 0),
    `${input.scenario} tool response must not include assistant prose.`,
  );

  if (isSubAgent) {
    input.sequence.subAgent += 1;
  } else {
    input.sequence.parent += 1;
  }
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
  const subAgentRequests = agentRequests.filter(({ request }) =>
    request.tools.some((tool) => readRequestToolName(tool) === subAgentResultToolName),
  );
  const parentRequests = agentRequests.filter(({ request }) =>
    request.tools.every((tool) => readRequestToolName(tool) !== subAgentResultToolName),
  );

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
    parentRequests.length === expectedParentToolSequence.length,
    `Expected exactly ${expectedParentToolSequence.length} parent Agent requests.`,
  );
  assertFeature(
    subAgentRequests.length === expectedSubAgentToolSequence.length,
    `Expected exactly ${expectedSubAgentToolSequence.length} sub-agent requests.`,
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

  assertFeature(
    parentRequests.every(({ request }) =>
      request.tools.every((tool) => readRequestToolName(tool) !== subAgentResultToolName),
    ),
    'Parent requests must not expose the dynamically injected agent-result tool.',
  );
  assertFeature(
    subAgentRequests.every(({ request }) =>
      request.tools.some((tool) => readRequestToolName(tool) === subAgentProofToolName),
    ),
    'Every sub-agent request must expose its decorated proof tool.',
  );
  assertFeature(
    subAgentRequests.every(({ request }) =>
      request.context.every((message) => {
        const text = input.readText(message);
        return !text.includes(seedMarker) && !text.includes(decoratedInputPrefix);
      }),
    ),
    'Sub-agent requests must not inherit parent history or compacted parent input.',
  );

  const parentResponseCalls = parentRequests.map((observation, index) => {
    const calls = input.parseCalls(observation.response);
    assertFeature(
      calls.length === 1,
      `Parent provider response ${index + 1} must contain exactly one tool call.`,
    );
    assertFeature(
      calls[0]?.name === expectedParentToolSequence[index],
      `Parent provider response ${index + 1} called an unexpected tool.`,
    );
    assertFeature(
      observation.response.every((message) => input.readText(message).trim().length === 0),
      `Parent provider response ${index + 1} must not include assistant prose.`,
    );
    return calls[0];
  });

  const subAgentResponseCalls = subAgentRequests.map((observation, index) => {
    const calls = input.parseCalls(observation.response);
    assertFeature(
      calls.length === 1,
      `Sub-agent provider response ${index + 1} must contain exactly one tool call.`,
    );
    assertFeature(
      calls[0]?.name === expectedSubAgentToolSequence[index],
      `Sub-agent provider response ${index + 1} called an unexpected tool.`,
    );
    assertFeature(
      observation.response.every((message) => input.readText(message).trim().length === 0),
      `Sub-agent provider response ${index + 1} must not include assistant prose.`,
    );
    return calls[0];
  });

  for (let index = 1; index < parentRequests.length; index += 1) {
    const previousCall = parentResponseCalls[index - 1];
    assertFeature(previousCall !== undefined, 'Missing the previous parent tool call.');
    const requestOutputs = input.parseOutputs(parentRequests[index]?.request.context ?? []);
    assertFeature(
      requestOutputs.some(({ callId }) => callId === previousCall.id),
      `Parent request ${index + 1} must consume the preceding parent tool result.`,
    );
  }

  for (let index = 1; index < subAgentRequests.length; index += 1) {
    const previousCall = subAgentResponseCalls[index - 1];
    assertFeature(previousCall !== undefined, 'Missing the previous sub-agent tool call.');
    const requestOutputs = input.parseOutputs(subAgentRequests[index]?.request.context ?? []);
    assertFeature(
      requestOutputs.some(({ callId }) => callId === previousCall.id),
      `Sub-agent request ${index + 1} must consume the preceding sub-agent tool result.`,
    );
  }

  const proofIndex = expectedParentToolSequence.indexOf(proofToolName);
  const proofCall = parentResponseCalls[proofIndex];
  assertFeature(proofCall?.name === proofToolName, 'Missing the parent proof tool call.');
  const proofConsumer = parentRequests[proofIndex + 1];
  assertFeature(proofConsumer !== undefined, 'Missing the request after the proof tool call.');
  const proofConsumerOutputs = input.parseOutputs(proofConsumer.request.context);
  const proofOutputSeenByParent = proofConsumerOutputs.find(
    ({ callId }) => callId === proofCall.id,
  )?.output;
  assertFeature(
    proofOutputSeenByParent?.includes(compactedProofPrefix) === true,
    'The next parent request must observe the compacted proof result.',
  );
  assertFeature(
    proofOutputSeenByParent !== input.evidence.proofPayload,
    'The next parent request must not receive the raw 20K proof result.',
  );

  const agentIndex = expectedParentToolSequence.indexOf('agent');
  const agentCall = parentResponseCalls[agentIndex];
  const endRequest = parentRequests[agentIndex + 1];
  assertFeature(agentCall?.name === 'agent', 'Missing the parent sub-agent dispatch call.');
  assertFeature(endRequest !== undefined, 'Missing the parent end-agent request.');
  const agentOutput = input
    .parseOutputs(endRequest.request.context)
    .find(({ callId }) => callId === agentCall.id)?.output;
  assertFeature(
    agentOutput?.includes(input.evidence.subAgentProofs[0] ?? '__missing_proof__') === true,
    'The parent end-agent request must consume the proof reported by the sub-agent.',
  );
}

function assertToolLoop(
  calls: readonly { name: string; sourceMessage: unknown }[],
  evidence: ScenarioEvidence,
  expectedSkillName: string,
  protocol: 'chat' | 'responses',
): void {
  const skillCalls = calls.filter((call) => call.name === 'skill');
  const decoratedCalls = calls.filter((call) => call.name === decoratedToolName);
  const proofCalls = calls.filter((call) => call.name === proofToolName);
  const agentCalls = calls.filter((call) => call.name === 'agent');
  const endCalls = calls.filter((call) => call.name === 'end-agent');

  assertFeature(
    skillCalls.length === 4,
    `Expected four progressive calls for ${expectedSkillName}.`,
  );
  assertFeature(decoratedCalls.length === 1, 'Expected one decorated tool wire call.');
  assertFeature(proofCalls.length === 1, 'Expected one proof tool wire call.');
  assertFeature(agentCalls.length === 1, 'Expected one parent sub-agent dispatch wire call.');
  assertFeature(endCalls.length === 1, 'Expected one end-agent wire call.');
  assertFeature(
    JSON.stringify(calls.map(({ name }) => name)) === JSON.stringify(expectedParentToolSequence),
    'Raw provider history must contain exactly the strict parent tool sequence.',
  );
  assertFeature(
    evidence.calledTools.filter((name) => name === 'skill').length === 4,
    'All four Skill calls must execute through the built-in runtime tool.',
  );
  assertFeature(
    JSON.stringify(evidence.calledTools) === JSON.stringify(expectedParentToolSequence),
    'Parent before-tool events must match the strict sequence without repeats.',
  );
  assertFeature(
    JSON.stringify(evidence.completedTools) === JSON.stringify(expectedParentToolSequence),
    `Parent after-tool events must match the strict sequence; received ${JSON.stringify(evidence.completedTools)}.`,
  );
  assertFeature(
    JSON.stringify(evidence.subAgentCalledTools) === JSON.stringify(expectedSubAgentToolSequence),
    'Sub-agent before-tool events must match proof/report/end.',
  );
  assertFeature(
    JSON.stringify(evidence.subAgentCompletedTools) ===
      JSON.stringify(expectedSubAgentToolSequence),
    'Sub-agent after-tool events must match proof/report/end.',
  );
  assertFeature(evidence.decoratedToolCalls === 1, 'Decorated parent tool must run exactly once.');
  assertFeature(
    evidence.decoratedHandlerPayloads.length === 1 &&
      evidence.decoratedHandlerPayloads[0]?.startsWith(`${decoratedInputPrefix}::${protocol}::`) ===
        true,
    'Decorated tool handler must receive the original marked payload.',
  );
  assertFeature(
    JSON.stringify(evidence.subAgentProofs) === JSON.stringify([expectedSubAgentProof(protocol)]),
    'Sub-agent decorated proof tool must build the exact protocol-specific marker once.',
  );
  assertFeature(
    JSON.stringify(evidence.parentSubAgentResults) ===
      JSON.stringify([expectedSubAgentProof(protocol)]),
    'Parent agent tool must receive the exact value reported through agent-result.',
  );
  assertFeature(
    calls.filter((call) => call.sourceMessage === endCalls[0]?.sourceMessage).length === 1,
    'end-agent must be the only tool call in its model response.',
  );
}

function assertPayloadCompaction(input: {
  readonly rawCalls: readonly { id: string; name: string; arguments: string }[];
  readonly activeCalls: readonly { id: string; name: string; arguments: string }[];
  readonly rawOutputs: readonly { message: { callId: string; output: string } }[];
  readonly activeOutputs: readonly { message: { callId: string; output: string } }[];
  readonly evidence: ScenarioEvidence;
}): void {
  const rawProof = findOutputForCallName(input.rawCalls, input.rawOutputs, proofToolName);
  const activeProof = findOutputForCallName(input.rawCalls, input.activeOutputs, proofToolName);
  const rawDecoratedCall = input.rawCalls.find(({ name }) => name === decoratedToolName);
  assertFeature(rawDecoratedCall !== undefined, 'Missing raw decorated tool call.');
  const activeDecoratedCall = input.activeCalls.find(({ id }) => id === rawDecoratedCall.id);
  assertFeature(activeDecoratedCall !== undefined, 'Missing active decorated tool call.');

  const rawDecoratedInput = JSON.parse(rawDecoratedCall.arguments) as {
    protocol?: unknown;
    payload?: unknown;
  };
  const handlerPayload = input.evidence.decoratedHandlerPayloads[0];
  assertFeature(handlerPayload !== undefined, 'Missing the decorated handler payload evidence.');
  assertFeature(
    rawDecoratedInput.payload === handlerPayload,
    'Raw history must retain the exact input received by the decorated handler.',
  );
  assertFeature(
    activeDecoratedCall.arguments.includes(compactedInputPrefix) &&
      !activeDecoratedCall.arguments.includes(handlerPayload),
    'Active context must replace decorated tool arguments with the compacted input marker.',
  );
  assertFeature(
    activeDecoratedCall.arguments.length < rawDecoratedCall.arguments.length,
    'Compacted decorated tool input must be shorter than the raw input.',
  );
  assertFeature(
    input.evidence.compactedInputCalls.includes(decoratedToolName),
    'The decorated tool must invoke the input compactor.',
  );

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

  const rawDecoratedOutput = findOutputForCallName(
    input.rawCalls,
    input.rawOutputs,
    decoratedToolName,
  );
  const activeDecoratedOutput = findOutputForCallName(
    input.rawCalls,
    input.activeOutputs,
    decoratedToolName,
  );
  assertFeature(
    rawDecoratedOutput === activeDecoratedOutput &&
      rawDecoratedOutput.includes(decoratedResultMarker),
    'Non-targeted decorated result must remain unchanged in active and raw context.',
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

function readRequestToolName(tool: unknown): string {
  if (typeof tool !== 'object' || tool === null) {
    return '';
  }

  const record = tool as Record<string, unknown>;
  if (typeof record.name === 'string') {
    return record.name;
  }

  const functionDefinition = record.function;
  if (typeof functionDefinition !== 'object' || functionDefinition === null) {
    return '';
  }

  const name = (functionDefinition as Record<string, unknown>).name;
  return typeof name === 'string' ? name : '';
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
        ...(failure.reason === undefined ? {} : { reason: failure.reason }),
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
    ...(failure.reason === undefined ? {} : { reason: failure.reason }),
    ...(error instanceof AggregateError ? { failedScenarios: error.errors.length } : {}),
  });
  process.exitCode = 1;
}
