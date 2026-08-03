import { describe, expect, it } from 'vitest';

import { Agent, DEFAULT_TOOL_PAYLOAD_COMPACT_LIMITS, Model, ModelErrorRecoveryError } from '../src';
import type {
  AfterModelErrorRecoveryEvent,
  BeforeModelErrorRecoveryEvent,
  ContextCompactOptions,
  ModelErrorDescriptor,
  ModelGeneratePurpose,
  ModelGenerateRequest,
  SummaryCompactPolicy,
  ToolPayloadCompactInfo,
  ToolPayloadReplacements,
} from '../src';
import { assistant, MockModel, type TestProtocol } from './helpers/mock-models';

interface PublicTypeContract {
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
void publicTypeContract;

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
  });
});
