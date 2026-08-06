import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';

import {
  Agent,
  OpenAIChatModel,
  type AgentSkill,
  type AgentToolCall,
  type ModelGenerateRequest,
  type ModelGenerateResult,
  type OpenAIChatContext,
  type OpenAIChatProtocol,
  type OpenAIChatRawToolCall,
  type ToolPayloadCompactor,
  type ToolRuntimeDefinition,
} from '../src';

type GenerateEntry =
  | ModelGenerateResult<OpenAIChatProtocol>
  | ((
      request: ModelGenerateRequest<OpenAIChatProtocol>,
      requestNumber: number,
    ) =>
      | ModelGenerateResult<OpenAIChatProtocol>
      | Promise<ModelGenerateResult<OpenAIChatProtocol>>);

class QueueChatModel extends OpenAIChatModel {
  readonly requests: ModelGenerateRequest<OpenAIChatProtocol>[] = [];

  constructor(private readonly entries: GenerateEntry[] = []) {
    super({ apiKey: 'offline-test-key', model: 'offline-chat-model' });
  }

  override async generate(
    request: ModelGenerateRequest<OpenAIChatProtocol>,
  ): Promise<ModelGenerateResult<OpenAIChatProtocol>> {
    const snapshot: ModelGenerateRequest<OpenAIChatProtocol> = {
      context: [...request.context],
      tools: [...request.tools],
      ...('purpose' in request ? { purpose: request.purpose } : {}),
    };
    this.requests.push(snapshot);
    const entry = this.entries.shift();

    if (!entry) {
      throw new Error('QueueChatModel response queue is empty.');
    }

    return typeof entry === 'function' ? entry(snapshot, this.requests.length) : entry;
  }
}

function inlineSkill(instructions = 'Follow the test instructions.'): AgentSkill {
  return {
    name: 'fixture-skill',
    description: 'A fixture Skill used by context compact integration tests.',
    instructions,
  };
}

function runtimeTool(
  name: string,
  handler: ToolRuntimeDefinition['handler'],
  parameters: ToolRuntimeDefinition['parameters'] = z.object({}),
): ToolRuntimeDefinition {
  return {
    name,
    description: `${name} fixture`,
    parameters,
    handler,
  };
}

function rawCall(id: string, name: string, argumentsText = '{}'): OpenAIChatRawToolCall {
  return {
    id,
    type: 'function',
    function: { name, arguments: argumentsText },
  };
}

function calls(
  ...toolCalls: readonly OpenAIChatRawToolCall[]
): ModelGenerateResult<OpenAIChatProtocol> {
  return {
    messages: [
      {
        role: 'assistant',
        content: null,
        tool_calls: toolCalls,
      },
    ],
  };
}

function parsedCall(
  id: string,
  name: string,
  argumentsText = '{}',
): AgentToolCall<OpenAIChatProtocol> {
  const sourceCall = rawCall(id, name, argumentsText);
  const sourceMessage = calls(sourceCall).messages[0] as OpenAIChatContext;

  return {
    id,
    name,
    arguments: argumentsText,
    sourceMessage,
    sourceCall,
  };
}

function findOutput(
  context: readonly OpenAIChatContext[],
  callId: string,
): Extract<OpenAIChatContext, { readonly role: 'tool' }> {
  const message = context.find(
    (candidate) => candidate.role === 'tool' && candidate.tool_call_id === callId,
  );

  if (message?.role !== 'tool') {
    throw new Error(`Expected tool output for ${callId}.`);
  }

  return message;
}

function readOutput(context: readonly OpenAIChatContext[], callId: string): string {
  const output = findOutput(context, callId).content;

  if (typeof output !== 'string') {
    throw new Error(`Expected a string tool output for ${callId}.`);
  }

  return output;
}

function readArguments(context: readonly OpenAIChatContext[], callId: string): string {
  for (const message of context) {
    if (message.role !== 'assistant') continue;

    const call = message.tool_calls?.find((candidate) => candidate.id === callId);
    if (call?.type === 'function') return call.function.arguments;
  }

  throw new Error(`Expected function arguments for ${callId}.`);
}

async function runOneLoop(agent: Agent<OpenAIChatProtocol>): Promise<void> {
  const outcome = await agent.agent('start');
  expect(outcome).toMatchObject({ status: 'failed', error: { code: 'LIMIT_EXCEEDED' } });
}

describe('Skill result context compact eligibility', () => {
  it('keeps built-in Skill output under the default policy while compacting ordinary output', async () => {
    const ordinaryResult = `ordinary:${'o'.repeat(2_000)}`;
    const model = new QueueChatModel([
      calls(
        rawCall('skill-default', 'skill', '{"skill":"fixture-skill"}'),
        rawCall('ordinary-default', 'ordinary'),
      ),
    ]);
    const agent = new Agent<OpenAIChatProtocol>({
      llm: model,
      maxIterations: 1,
      skills: [inlineSkill(`skill:${'s'.repeat(2_000)}`)],
      contextCompact: {
        toolInput: false,
        toolResult: {
          strategy: 'default',
          thresholdChars: 600,
          targetChars: 512,
        },
      },
    });
    agent.tools.push(runtimeTool('ordinary', () => ordinaryResult));
    agent.init();

    await runOneLoop(agent);

    const raw = agent.getHistory();
    const active = agent.getContext();
    const rawSkill = findOutput(raw, 'skill-default');
    const activeSkill = findOutput(active, 'skill-default');
    const rawOrdinary = readOutput(raw, 'ordinary-default');
    const activeOrdinary = readOutput(active, 'ordinary-default');

    expect(typeof rawSkill.content === 'string' ? rawSkill.content.length : 0).toBeGreaterThan(600);
    expect(activeSkill).toBe(rawSkill);
    expect(activeSkill.content).toBe(rawSkill.content);
    expect(rawOrdinary).toBe(ordinaryResult);
    expect(activeOrdinary).not.toBe(ordinaryResult);
    expect(activeOrdinary.length).toBeLessThanOrEqual(512);
    expect(activeOrdinary).toContain('context compacted');
  });

  it('still compacts Skill input while hiding its result from a custom result compactor', async () => {
    const originalArguments = '{"skill":"fixture-skill"}';
    const inputCompactor = vi.fn<ToolPayloadCompactor>(() => '{"skill":"input-compacted"}');
    const resultCompactor = vi.fn<ToolPayloadCompactor>(() => '[must not run]');
    const model = new QueueChatModel([
      calls(rawCall('skill-custom-default', 'skill', originalArguments)),
    ]);
    const agent = new Agent<OpenAIChatProtocol>({
      llm: model,
      maxIterations: 1,
      skills: [inlineSkill()],
      contextCompact: {
        toolInput: inputCompactor,
        toolResult: resultCompactor,
      },
    });
    agent.init();

    await runOneLoop(agent);

    expect(inputCompactor).toHaveBeenCalledOnce();
    expect(inputCompactor).toHaveBeenCalledWith(
      originalArguments,
      expect.objectContaining({
        kind: 'tool_input',
        call: expect.objectContaining({ id: 'skill-custom-default', name: 'skill' }),
      }),
    );
    expect(resultCompactor).not.toHaveBeenCalled();
    expect(readArguments(agent.getHistory(), 'skill-custom-default')).toBe(originalArguments);
    expect(readArguments(agent.getContext(), 'skill-custom-default')).toBe(
      '{"skill":"input-compacted"}',
    );
    expect(findOutput(agent.getContext(), 'skill-custom-default')).toBe(
      findOutput(agent.getHistory(), 'skill-custom-default'),
    );
  });

  it('opts built-in Skill output into custom compaction only when explicitly enabled', async () => {
    const resultCompactor = vi.fn<ToolPayloadCompactor>((original, info) => {
      expect(original).toContain('Follow the test instructions.');
      expect(info).toEqual(
        expect.objectContaining({
          kind: 'tool_result',
          call: expect.objectContaining({ id: 'skill-explicit', name: 'skill' }),
        }),
      );
      return '[compacted Skill output]';
    });
    const model = new QueueChatModel([
      calls(rawCall('skill-explicit', 'skill', '{"skill":"fixture-skill"}')),
    ]);
    const agent = new Agent<OpenAIChatProtocol>({
      llm: model,
      maxIterations: 1,
      skills: [inlineSkill()],
      skillRuntime: { compactResult: true },
      contextCompact: { toolInput: false, toolResult: resultCompactor },
    });
    agent.init();

    await runOneLoop(agent);

    expect(resultCompactor).toHaveBeenCalledOnce();
    expect(readOutput(agent.getHistory(), 'skill-explicit')).toContain(
      'Follow the test instructions.',
    );
    expect(readOutput(agent.getContext(), 'skill-explicit')).toBe('[compacted Skill output]');
    expect(findOutput(agent.getContext(), 'skill-explicit')).not.toBe(
      findOutput(agent.getHistory(), 'skill-explicit'),
    );
  });

  it('uses the Skill policy for JSON, schema, before-cancel, and handler-error records', async () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'agent-skill-compact-'));
    const root = join(temporaryRoot, 'fixture-skill');
    const resourceDirectory = join(root, 'references');
    const resourcePath = join(resourceDirectory, 'fail.md');

    try {
      mkdirSync(root);
      mkdirSync(resourceDirectory);
      writeFileSync(
        join(root, 'SKILL.md'),
        [
          '---',
          'name: fixture-skill',
          'description: File fixture.',
          '---',
          'Follow the file fixture instructions.',
        ].join('\n'),
      );
      writeFileSync(resourcePath, 'lazy resource');

      const sourceCalls = [
        rawCall('skill-json-error', 'skill', '{'),
        rawCall('skill-schema-error', 'skill', '{"skill":42}'),
        rawCall('skill-before-error', 'skill', '{"skill":"fixture-skill","args":"load before"}'),
        rawCall(
          'skill-handler-error',
          'skill',
          '{"skill":"fixture-skill","args":"read references/fail.md"}',
        ),
      ] as const;
      const inputCompactor = vi.fn<ToolPayloadCompactor>((_original, info) =>
        JSON.stringify({ compacted: info.call.id }),
      );
      const resultCompactor = vi.fn<ToolPayloadCompactor>(() => '[must not run]');
      const model = new QueueChatModel([calls(...sourceCalls)]);
      const agent = new Agent<OpenAIChatProtocol>({
        llm: model,
        maxIterations: 1,
        skills: [{ source: 'file', path: root }],
        contextCompact: {
          toolInput: inputCompactor,
          toolResult: resultCompactor,
        },
      });
      agent.onBeforeToolCall(
        'skill',
        (_parameters, call) => {
          if (call.id === 'skill-before-error') {
            throw new Error('before blocked');
          }
        },
        { await: true, errorCancel: true },
      );
      agent.init();
      unlinkSync(resourcePath);

      await runOneLoop(agent);

      expect(inputCompactor).toHaveBeenCalledTimes(sourceCalls.length);
      expect(resultCompactor).not.toHaveBeenCalled();
      for (const call of sourceCalls) {
        expect(readArguments(agent.getContext(), call.id)).toBe(
          JSON.stringify({ compacted: call.id }),
        );
        expect(findOutput(agent.getContext(), call.id)).toBe(
          findOutput(agent.getHistory(), call.id),
        );
      }
      expect(readOutput(agent.getHistory(), 'skill-json-error').length).toBeGreaterThan(0);
      expect(readOutput(agent.getHistory(), 'skill-schema-error')).toContain('skill');
      expect(readOutput(agent.getHistory(), 'skill-before-error')).toContain('before blocked');
      expect(readOutput(agent.getHistory(), 'skill-handler-error')).toContain(
        'Skill resource-read failed for fixture-skill:references/fail.md.',
      );
      expect(readOutput(agent.getHistory(), 'skill-handler-error')).not.toContain(root);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('treats a same-name replacement by runtime definition identity as an ordinary tool', async () => {
    const resultCompactor = vi.fn<ToolPayloadCompactor>(() => '[compacted replacement output]');
    const model = new QueueChatModel([
      calls(rawCall('replacement-skill', 'skill', '{"value":"original"}')),
    ]);
    const agent = new Agent<OpenAIChatProtocol>({
      llm: model,
      maxIterations: 1,
      contextCompact: { toolInput: false, toolResult: resultCompactor },
    });
    const skillIndex = agent.tools.findIndex((tool) => tool.name === 'skill');

    expect(skillIndex).toBeGreaterThanOrEqual(0);
    agent.tools[skillIndex] = runtimeTool(
      'skill',
      () => 'ordinary replacement output',
      z.object({ value: z.string() }),
    );
    agent.init();

    await runOneLoop(agent);

    expect(resultCompactor).toHaveBeenCalledOnce();
    expect(readOutput(agent.getHistory(), 'replacement-skill')).toBe('ordinary replacement output');
    expect(readOutput(agent.getContext(), 'replacement-skill')).toBe(
      '[compacted replacement output]',
    );
  });
});

describe('Skill compact transactions and standalone calls', () => {
  it('rolls back an explicitly enabled Skill replacement when the compactor throws', async () => {
    const model = new QueueChatModel([
      calls(rawCall('skill-callback-failure', 'skill', '{"skill":"fixture-skill"}')),
    ]);
    const agent = new Agent<OpenAIChatProtocol>({
      llm: model,
      maxIterations: 1,
      skills: [inlineSkill()],
      skillRuntime: { compactResult: true },
      contextCompact: {
        toolInput: false,
        toolResult: () => {
          throw new Error('Skill result compactor failed');
        },
      },
    });
    agent.init();

    const outcome = await agent.agent('start');
    expect(outcome).toMatchObject({ status: 'failed', error: { code: 'INTERNAL_ERROR' } });

    const raw = agent.getHistory();
    const active = agent.getContext();
    expect(active).toHaveLength(raw.length);
    active.forEach((message, index) => expect(message).toBe(raw[index]));
    expect(readOutput(active, 'skill-callback-failure')).toContain('Follow the test instructions.');
  });

  it('rejects a stale Skill rewrite by revision CAS and preserves the concurrent append', async () => {
    const model = new QueueChatModel([
      calls(rawCall('skill-cas', 'skill', '{"skill":"fixture-skill"}')),
    ]);
    let appended = false;
    const agent = new Agent<OpenAIChatProtocol>({
      llm: model,
      maxIterations: 1,
      skills: [inlineSkill()],
      skillRuntime: { compactResult: true },
      contextCompact: {
        toolInput: false,
        toolResult: () => {
          if (!appended) {
            appended = true;
            agent.appendContext({ role: 'user', content: 'concurrent Skill compact append' });
          }
          return '[stale Skill replacement]';
        },
      },
    });
    agent.init();

    const outcome = await agent.agent('start');
    expect(outcome).toMatchObject({ status: 'failed', error: { code: 'INTERNAL_ERROR' } });

    const raw = agent.getHistory();
    const active = agent.getContext();
    expect(active).toHaveLength(raw.length);
    active.forEach((message, index) => expect(message).toBe(raw[index]));
    expect(raw.at(-1)).toEqual({ role: 'user', content: 'concurrent Skill compact append' });
    expect(readOutput(active, 'skill-cas')).toContain('Follow the test instructions.');
    expect(readOutput(active, 'skill-cas')).not.toBe('[stale Skill replacement]');
  });

  it('does not run input or result compactors for standalone Skill toolCall()', async () => {
    const inputCompactor = vi.fn<ToolPayloadCompactor>(() => '[input replacement]');
    const resultCompactor = vi.fn<ToolPayloadCompactor>(() => '[result replacement]');
    const agent = new Agent<OpenAIChatProtocol>({
      llm: new QueueChatModel(),
      skills: [inlineSkill()],
      skillRuntime: { compactResult: true },
      contextCompact: {
        toolInput: inputCompactor,
        toolResult: resultCompactor,
      },
    });
    agent.init();

    const result = await agent.toolCall(
      parsedCall('skill-standalone', 'skill', '{"skill":"fixture-skill"}'),
    );

    expect(inputCompactor).not.toHaveBeenCalled();
    expect(resultCompactor).not.toHaveBeenCalled();
    expect(result.role).toBe('tool');
    expect(
      result.role === 'tool' && typeof result.content === 'string' ? result.content : '',
    ).toContain('Follow the test instructions.');
    expect(agent.getHistory()).toEqual([result]);
    expect(agent.getContext()).toEqual([result]);
    expect(agent.getHistory()[0]).toBe(agent.getContext()[0]);
  });
});
