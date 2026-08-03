import { describe, expect, it } from 'vitest';

import {
  Agent,
  DEFAULT_SKILL_TEXT_RESOURCE_EXTENSIONS,
  DEFAULT_TOOL_PAYLOAD_COMPACT_LIMITS,
  Model,
  ModelErrorRecoveryError,
  detectSkillScriptExecutors,
} from '../src';
import {
  DEFAULT_SKILL_TEXT_RESOURCE_EXTENSIONS as AGENT_DEFAULT_SKILL_TEXT_RESOURCE_EXTENSIONS,
  detectSkillScriptExecutors as detectSkillScriptExecutorsFromAgent,
} from '../src/agent';
import type {
  AgentOptions,
  AgentSkill,
  AgentSkillDescriptor,
  AgentSkillFileSource,
  AgentSkillScript,
  AgentSkillSource,
  AgentSkillSourceDiagnostic,
  AgentSkillSourceDiagnosticReason,
  AfterModelErrorRecoveryEvent,
  BeforeModelErrorRecoveryEvent,
  ContextCompactOptions,
  ModelErrorDescriptor,
  ModelGeneratePurpose,
  ModelGenerateRequest,
  SummaryCompactPolicy,
  SkillRuntimeOptions,
  SkillScriptExecutionResult,
  SkillScriptExecutor,
  SkillScriptExecutorMap,
  SkillScriptRuntimeOptions,
  SkillToolInput,
  ToolDescriptionContext,
  ToolPayloadCompactInfo,
  ToolPayloadReplacements,
} from '../src';
import type { AgentSkillScript as AgentBarrelSkillScript } from '../src/agent';
import { assistant, MockModel, type TestProtocol } from './helpers/mock-models';

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;
type Assert<Value extends true> = Value;

type PublicSkillSignatureAssertions = [
  Assert<Equal<SkillToolInput, { readonly skill: string; readonly args?: string }>>,
  Assert<Equal<ToolDescriptionContext['skills'], readonly AgentSkillDescriptor[]>>,
  Assert<
    Equal<
      Pick<AgentOptions<TestProtocol>, 'skills' | 'skillRuntime'>,
      {
        skills?: readonly AgentSkillSource[];
        skillRuntime?: SkillRuntimeOptions;
      }
    >
  >,
  Assert<Equal<Parameters<Agent<TestProtocol>['addSkill']>, AgentSkillSource[]>>,
  Assert<Equal<ReturnType<Agent<TestProtocol>['addSkill']>, Agent<TestProtocol>>>,
  Assert<
    Equal<
      ReturnType<Agent<TestProtocol>['getSkillSourceDiagnostics']>,
      readonly AgentSkillSourceDiagnostic[]
    >
  >,
];

interface PublicTypeContract {
  skillInput: SkillToolInput;
  skillDescriptor: AgentSkillDescriptor;
  inlineSkill: AgentSkill;
  inlineSkillScript: AgentSkillScript;
  agentBarrelSkillScript: AgentBarrelSkillScript;
  fileSkill: AgentSkillFileSource;
  skillSource: AgentSkillSource;
  skillRuntime: SkillRuntimeOptions;
  scriptRuntime: SkillScriptRuntimeOptions;
  scriptExecutor: SkillScriptExecutor;
  scriptExecutors: SkillScriptExecutorMap;
  scriptResult: SkillScriptExecutionResult;
  skillDiagnostic: AgentSkillSourceDiagnostic;
  skillDiagnosticReason: AgentSkillSourceDiagnosticReason;
  compact: ContextCompactOptions<TestProtocol>;
  purpose: ModelGeneratePurpose;
  request: ModelGenerateRequest<TestProtocol>;
  descriptor: ModelErrorDescriptor;
  info: ToolPayloadCompactInfo;
  replacements: ToolPayloadReplacements<TestProtocol>;
  summary: SummaryCompactPolicy<TestProtocol>;
  before: BeforeModelErrorRecoveryEvent<TestProtocol>;
  after: AfterModelErrorRecoveryEvent<TestProtocol>;
}

// The annotation is a compile-time root-entry type export check.
const publicTypeContract: PublicTypeContract | undefined = undefined;
const publicSkillSignatureAssertions: PublicSkillSignatureAssertions | undefined = undefined;
void publicTypeContract;
void publicSkillSignatureAssertions;

describe('public API compatibility', () => {
  it('keeps old custom Model subclasses source-compatible with optional capabilities', () => {
    const model: Model<TestProtocol> = new MockModel();
    const original = [assistant('summary text')] as const;

    const rewritten = model.rewriteToolPayloads(original, { inputs: [], results: [] });
    expect(rewritten).not.toBe(original);
    expect(rewritten).toEqual(original);
    expect(model.extractAssistantText(original)).toEqual(['summary text']);
    expect(
      model.classifyError(new Error('provider failed'), {
        purpose: 'agent',
        request: { context: original, tools: [] },
      }),
    ).toEqual({ kind: 'unknown', message: 'provider failed' });
    expect(() =>
      model.rewriteToolPayloads(original, {
        inputs: [
          {
            sourceMessage: original[0],
            sourceCall: {
              id: 'detached',
              type: 'function',
              function: { name: 'tool', arguments: '{}' },
            },
            replacement: '{"compact":true}',
          },
        ],
        results: [],
      }),
    ).toThrow(/does not support tool payload rewriting/u);
  });

  it('exports new runtime values from the package root', () => {
    expect(Agent).toBeTypeOf('function');
    expect(Model).toBeTypeOf('function');
    expect(DEFAULT_TOOL_PAYLOAD_COMPACT_LIMITS).toEqual({
      toolInput: { thresholdChars: 8_192, targetChars: 4_096 },
      toolResult: { thresholdChars: 16_384, targetChars: 8_192 },
    });
    expect(Object.isFrozen(DEFAULT_TOOL_PAYLOAD_COMPACT_LIMITS)).toBe(true);
    expect(ModelErrorRecoveryError).toBeTypeOf('function');
    expect(ModelErrorRecoveryError.prototype).toBeInstanceOf(Error);
    expect(DEFAULT_SKILL_TEXT_RESOURCE_EXTENSIONS).toEqual([
      '.md',
      '.txt',
      '.json',
      '.yaml',
      '.yml',
      '.csv',
      '.xml',
    ]);
    expect(Object.isFrozen(DEFAULT_SKILL_TEXT_RESOURCE_EXTENSIONS)).toBe(true);
    expect(AGENT_DEFAULT_SKILL_TEXT_RESOURCE_EXTENSIONS).toBe(
      DEFAULT_SKILL_TEXT_RESOURCE_EXTENSIONS,
    );
    expect(detectSkillScriptExecutorsFromAgent).toBe(detectSkillScriptExecutors);

    const firstDetection = detectSkillScriptExecutors();
    const secondDetection = detectSkillScriptExecutors();
    expect(firstDetection).not.toBe(secondDetection);
    expect(detectSkillScriptExecutors).toBeTypeOf('function');

    firstDetection['.fixture'] = { command: 'fixture', commandArgs: ['--first'] };
    expect(secondDetection['.fixture']).toBeUndefined();

    const detectedExtension = Object.keys(firstDetection).find(
      (extension) => extension !== '.fixture' && secondDetection[extension] !== undefined,
    );
    if (detectedExtension !== undefined) {
      const firstExecutor = firstDetection[detectedExtension];
      const secondExecutor = secondDetection[detectedExtension];

      expect(firstExecutor).not.toBe(secondExecutor);
      if (firstExecutor?.commandArgs !== undefined && secondExecutor?.commandArgs !== undefined) {
        expect(firstExecutor.commandArgs).not.toBe(secondExecutor.commandArgs);
      }
    }
  });
});
