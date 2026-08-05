import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';

import { Agent } from '../src';
import { SkillRuntimeError } from '../src/agent/skill-registry-types';
import type {
  AgentSkill,
  AgentSkillDescriptor,
  AgentSkillFileSource,
  AgentSkillSourceDiagnostic,
  ToolRuntimeDefinition,
} from '../src/agent/types';
import {
  assistant,
  endResponse,
  MockModel,
  parsedCall,
  readToolOutput,
  response,
  toolCall,
  type TestContext,
  type TestProtocol,
} from './helpers/mock-models';

function inlineSkill(overrides: Partial<AgentSkill> = {}): AgentSkill {
  return {
    name: 'invoice-review',
    description: 'Review invoices against billing policy.',
    instructions: 'PRIVATE_WORKFLOW: inspect every invoice. Arguments=$ARGUMENTS',
    references: {
      'private-policy.md': 'PRIVATE_POLICY_CONTENT',
    },
    scripts: {
      verify: {
        extension: '.js',
        content: 'PRIVATE_SCRIPT_SOURCE',
        description: 'Check invoice totals.',
      },
    },
    license: 'PRIVATE_LICENSE_TOKEN',
    metadata: { owner: 'PRIVATE_OWNER_TOKEN' },
    ...overrides,
  };
}

function systemText(context: readonly TestContext[]): string {
  return context
    .filter((message) => message.kind === 'system')
    .map((message) => message.content)
    .join('\n');
}

function toolOutput(context: readonly TestContext[], callId: string): string {
  const message = context.find(
    (candidate): candidate is Extract<TestContext, { kind: 'tool' }> =>
      candidate.kind === 'tool' && candidate.callId === callId,
  );

  if (!message) throw new Error(`Missing tool output for ${callId}.`);
  return message.output;
}

describe('Agent Skill progressive disclosure', () => {
  it('reveals descriptors, load instructions, and resources in separate model turns', async () => {
    const model = new MockModel([
      response(
        assistant('', [
          toolCall('skill-load', 'skill', JSON.stringify({ skill: 'invoice-review' })),
        ]),
      ),
      response(
        assistant('', [
          toolCall(
            'skill-read',
            'skill',
            JSON.stringify({
              skill: 'invoice-review',
              args: 'read references/private-policy.md',
            }),
          ),
        ]),
      ),
      endResponse(),
    ]);
    const descriptionSnapshots: Array<readonly AgentSkillDescriptor[]> = [];
    const dynamicTool: ToolRuntimeDefinition = {
      name: 'descriptor-observer',
      description(context) {
        descriptionSnapshots.push(context.skills);
        return 'Observe descriptor-only Skill context.';
      },
      parameters: z.object({}),
      handler: () => 'unused',
    };
    const agent = new Agent<TestProtocol>({
      llm: model,
      skills: [inlineSkill()],
    });
    agent.tools.push(dynamicTool);
    agent.init();

    await agent.agent('review this invoice');

    expect(model.requests).toHaveLength(3);
    const firstRequest = model.requests[0];
    if (!firstRequest) throw new Error('Expected the first model request.');
    const firstPrompt = systemText(firstRequest.context);

    expect(firstPrompt).toContain('invoice-review');
    expect(firstPrompt).toContain('Review invoices against billing policy.');
    for (const undisclosed of [
      'PRIVATE_WORKFLOW',
      'references/private-policy.md',
      'scripts/verify.js',
      'PRIVATE_SCRIPT_SOURCE',
      'PRIVATE_LICENSE_TOKEN',
      'PRIVATE_OWNER_TOKEN',
    ]) {
      expect(firstPrompt).not.toContain(undisclosed);
    }

    const skillDefinition = firstRequest.tools.find((tool) => tool.name === 'skill');
    expect(skillDefinition).toBeDefined();
    expect(skillDefinition?.parameters?.safeParse({ skill: 'invoice-review' }).success).toBe(true);
    expect(
      skillDefinition?.parameters?.safeParse({ skill: 'invoice-review', args: 'load details' })
        .success,
    ).toBe(true);
    expect(skillDefinition?.parameters?.safeParse({}).success).toBe(false);
    expect(
      skillDefinition?.parameters?.safeParse({ skill: 'invoice-review', args: 1 }).success,
    ).toBe(false);

    expect(descriptionSnapshots).toHaveLength(3);
    for (const descriptors of descriptionSnapshots) {
      expect(descriptors).toEqual([
        { name: 'invoice-review', description: 'Review invoices against billing policy.' },
      ]);
      expect(Object.isFrozen(descriptors)).toBe(true);
      expect(Object.isFrozen(descriptors[0])).toBe(true);
      expect(Object.keys(descriptors[0] ?? {})).toEqual(['name', 'description']);
    }

    const secondRequest = model.requests[1];
    const thirdRequest = model.requests[2];
    if (!secondRequest || !thirdRequest) throw new Error('Expected all model requests.');
    const loaded = toolOutput(secondRequest.context, 'skill-load');

    expect(loaded).toContain('PRIVATE_WORKFLOW');
    expect(loaded).toContain('references/private-policy.md');
    expect(loaded).toContain('scripts/verify.js [unavailable]');
    expect(loaded).not.toContain('PRIVATE_POLICY_CONTENT');
    expect(loaded).not.toContain('PRIVATE_SCRIPT_SOURCE');
    expect(toolOutput(thirdRequest.context, 'skill-read')).toBe('PRIVATE_POLICY_CONTENT');

    expect(
      agent
        .getHistory()
        .some((message) => message.kind === 'tool' && message.output === 'PRIVATE_POLICY_CONTENT'),
    ).toBe(true);
  });

  it('supports standalone load/read without invoking the model or payload compactors', async () => {
    const model = new MockModel();
    const compactInput = vi.fn((value: string) => `compact:${value}`);
    const compactResult = vi.fn((value: string) => `compact:${value}`);
    const agent = new Agent<TestProtocol>({
      llm: model,
      skills: [inlineSkill()],
      contextCompact: {
        toolInput: compactInput,
        toolResult: compactResult,
      },
    });
    agent.init();

    const loaded = await agent.toolCall(
      parsedCall('standalone-load', 'skill', JSON.stringify({ skill: 'invoice-review' })),
    );
    const resource = await agent.toolCall(
      parsedCall(
        'standalone-read',
        'skill',
        JSON.stringify({
          skill: 'invoice-review',
          args: 'read references/private-policy.md',
        }),
      ),
    );

    expect(readToolOutput(loaded)).toContain('PRIVATE_WORKFLOW');
    expect(readToolOutput(resource)).toBe('PRIVATE_POLICY_CONTENT');
    expect(model.requests).toEqual([]);
    expect(compactInput).not.toHaveBeenCalled();
    expect(compactResult).not.toHaveBeenCalled();
    expect(agent.getContext()).toEqual([loaded, resource]);
    expect(agent.getHistory()).toEqual([loaded, resource]);
  });
});

describe('Agent Skill runtime failures', () => {
  it('exposes a sanitized tool result, a typed event error, and its original cause', async () => {
    const temporaryParent = mkdtempSync(join(tmpdir(), 'manee-skill-agent-test-'));
    const skillRoot = join(temporaryParent, 'file-skill');
    const referencesRoot = join(skillRoot, 'references');
    const resourcePath = join(referencesRoot, 'policy.md');

    try {
      mkdirSync(referencesRoot, { recursive: true });
      writeFileSync(
        join(skillRoot, 'SKILL.md'),
        '---\nname: file-skill\ndescription: Read a file policy.\n---\nFollow the policy.',
      );
      writeFileSync(resourcePath, 'FILE_POLICY_CONTENT');

      const agent = new Agent<TestProtocol>({
        llm: new MockModel(),
        skills: [{ source: 'file', path: skillRoot }],
      });
      let observedError: unknown;
      agent.onToolCallError((_name, trigger, error) => {
        expect(trigger).toBe('calling');
        observedError = error;
      });
      agent.init();
      expect(agent.getSkillSourceDiagnostics()).toEqual([]);

      unlinkSync(resourcePath);
      const result = await agent.toolCall(
        parsedCall(
          'failed-resource-read',
          'skill',
          JSON.stringify({ skill: 'file-skill', args: 'read references/policy.md' }),
        ),
      );

      expect(observedError).toBeInstanceOf(SkillRuntimeError);
      const runtimeError = observedError as SkillRuntimeError;
      expect(runtimeError).toMatchObject({
        stage: 'resource-read',
        skill: 'file-skill',
        target: 'references/policy.md',
      });
      expect(runtimeError.message).toBe(
        'Skill resource-read failed for file-skill:references/policy.md.',
      );
      expect(runtimeError.message).not.toContain(skillRoot);
      expect(runtimeError.cause).toBeInstanceOf(Error);
      expect(runtimeError.cause).toMatchObject({ code: 'ENOENT' });

      const visibleResult = readToolOutput(result);
      expect(visibleResult).toBe(runtimeError.message);
      expect(visibleResult).not.toContain(skillRoot);
      expect(visibleResult).not.toContain('ENOENT');
    } finally {
      rmSync(temporaryParent, { recursive: true, force: true });
    }
  });
});

describe('Agent Skill registry lifecycle', () => {
  it('marks idle additions dirty and exposes them only after a successful re-init', async () => {
    const agent = new Agent<TestProtocol>({ llm: new MockModel(), skills: [inlineSkill()] });
    agent.init();
    agent.addSkill(
      inlineSkill({
        name: 'new-skill',
        description: 'Newly registered skill.',
        instructions: 'NEW_SKILL_INSTRUCTIONS',
        references: {},
        scripts: {},
      }),
    );

    await expect(
      agent.toolCall(parsedCall('dirty-load', 'skill', JSON.stringify({ skill: 'new-skill' }))),
    ).rejects.toThrow(/not been initialized/iu);

    agent.init();
    const result = await agent.toolCall(
      parsedCall('clean-load', 'skill', JSON.stringify({ skill: 'new-skill' })),
    );
    expect(readToolOutput(result)).toContain('NEW_SKILL_INSTRUCTIONS');
  });

  it('keeps the running registry stable, blocks init, then invalidates on completion', async () => {
    let markStarted!: () => void;
    let releaseModel!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const held = new Promise<void>((resolve) => {
      releaseModel = resolve;
    });
    const model = new MockModel([
      async () => {
        markStarted();
        await held;
        return endResponse();
      },
    ]);
    const agent = new Agent<TestProtocol>({ llm: model, skills: [inlineSkill()] });
    agent.init();

    const running = agent.agent('start');
    await started;
    agent.addSkill(
      inlineSkill({
        name: 'late-skill',
        description: 'Added while the Agent is running.',
        instructions: 'LATE_SKILL_INSTRUCTIONS',
        references: {},
        scripts: {},
      }),
    );
    expect(() => agent.init()).toThrow(/while it is running/iu);
    expect(systemText(model.requests[0]?.context ?? [])).not.toContain('late-skill');

    releaseModel();
    await running;
    await expect(
      agent.toolCall(
        parsedCall('late-before-init', 'skill', JSON.stringify({ skill: 'late-skill' })),
      ),
    ).rejects.toThrow(/not been initialized/iu);

    agent.init();
    const loaded = await agent.toolCall(
      parsedCall('late-after-init', 'skill', JSON.stringify({ skill: 'late-skill' })),
    );
    expect(readToolOutput(loaded)).toContain('LATE_SKILL_INSTRUCTIONS');
  });

  it('freezes diagnostics and preserves the last successful snapshot after init failure', () => {
    const inaccessibleSource = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(inaccessibleSource, 'source', {
      enumerable: true,
      value: 'file',
    });
    Object.defineProperty(inaccessibleSource, 'path', {
      enumerable: true,
      get() {
        throw new Error('The path getter must remain behind the capability gate.');
      },
    });
    const agent = new Agent<TestProtocol>({
      llm: new MockModel(),
      skills: [inlineSkill(), inaccessibleSource as unknown as AgentSkillFileSource],
    });
    const builtinModuleSpy = vi
      .spyOn(process, 'getBuiltinModule')
      .mockImplementation(() => undefined as never);

    try {
      agent.init();
      const diagnostics = agent.getSkillSourceDiagnostics();

      expect(diagnostics).toEqual([
        { sourceIndex: 1, reason: 'file_capability_unavailable' },
      ] satisfies AgentSkillSourceDiagnostic[]);
      expect(Object.isFrozen(diagnostics)).toBe(true);
      expect(Object.isFrozen(diagnostics[0])).toBe(true);

      agent.addSkill(inlineSkill({ name: 'INVALID' }));
      expect(() => agent.init()).toThrow(/name/iu);
      expect(agent.getSkillSourceDiagnostics()).toBe(diagnostics);
    } finally {
      builtinModuleSpy.mockRestore();
    }
  });
});
