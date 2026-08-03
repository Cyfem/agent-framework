/**
 * Agent Skills 离线验收套件。
 *
 * 该入口复用真实 Chat adapter、Node file/process capability 和 Agent 主循环，但不发起网络请求。
 * 每个场景都包含强断言，任何契约回归都会令进程以非零状态退出。
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { z } from 'zod';

import {
  Agent,
  OpenAIChatModel,
  type AgentSkill,
  type AgentSkillDescriptor,
  type AgentToolCall,
  type ModelGenerateRequest,
  type ModelGenerateResult,
  type OpenAIChatContext,
  type OpenAIChatProtocol,
  type OpenAIChatRawToolCall,
  type ToolPayloadCompactor,
  type ToolRuntimeDefinition,
} from '@manee/agent-framework';

type GenerateEntry =
  | ModelGenerateResult<OpenAIChatProtocol>
  | ((
      request: ModelGenerateRequest<OpenAIChatProtocol>,
      requestNumber: number,
    ) =>
      | ModelGenerateResult<OpenAIChatProtocol>
      | Promise<ModelGenerateResult<OpenAIChatProtocol>>);

interface ScriptResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

interface InspectorOutput {
  argv: string[];
  guide: string;
  payload: string;
  cwdBase: string;
  skillDocumentMatches: boolean;
  completeTree: boolean;
}

interface FileExecutionProbe {
  scriptUrl: string;
  cwd: string;
}

interface SkillDispatchError {
  ok: false;
  error: {
    code: string;
    message: string;
  };
}

const fixtureRoot = fileURLToPath(new URL('../../fixtures/skills/portable-demo', import.meta.url));
const inlineGuide = 'INLINE_PRIVATE_GUIDE';
const inlinePayload = 'INLINE_PRIVATE_ASSET';
const inlineScriptMarker = 'INLINE_SCRIPT_SOURCE_MARKER';
const inlineInstructions =
  'INLINE_PRIVATE_INSTRUCTIONS: inspect the materialized resources. Arguments=$ARGUMENTS';
const inlineSkillDocument = [
  '---',
  'name: inline-inspector',
  'description: Inspects an inline Skill materialized into an isolated temporary directory.',
  'license: INLINE_PRIVATE_LICENSE',
  'compatibility: INLINE_PRIVATE_COMPATIBILITY',
  'metadata:',
  '  owner: INLINE_PRIVATE_OWNER',
  '---',
  inlineInstructions,
].join('\n');

const inlineInspector: AgentSkill = {
  name: 'inline-inspector',
  description: 'Inspects an inline Skill materialized into an isolated temporary directory.',
  license: 'INLINE_PRIVATE_LICENSE',
  compatibility: 'INLINE_PRIVATE_COMPATIBILITY',
  metadata: { owner: 'INLINE_PRIVATE_OWNER' },
  instructions: inlineInstructions,
  references: {
    'z-last.md': 'INLINE_REFERENCE_Z',
    'guide.md': inlineGuide,
    'a-first.md': 'INLINE_REFERENCE_A',
  },
  assets: {
    'z-last.txt': 'INLINE_ASSET_Z',
    'payload.txt': inlinePayload,
    'a-first.txt': 'INLINE_ASSET_A',
  },
  scripts: {
    'z-helper': {
      extension: '.mjs',
      content: '// INLINE_HELPER_Z',
    },
    inspect: {
      extension: '.mjs',
      description: 'Inspect argv and materialized resources.',
      content: `// ${inlineScriptMarker}
import { appendFileSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const argv = process.argv.slice(2);
const guide = readFileSync(join(process.cwd(), 'references', 'guide.md'), 'utf8').trim();
const payload = readFileSync(join(process.cwd(), 'assets', 'payload.txt'), 'utf8').trim();
const skillDocument = readFileSync(join(process.cwd(), 'SKILL.md'), 'utf8');
const completeTree =
  readFileSync(join(process.cwd(), 'references', 'a-first.md'), 'utf8') ===
    'INLINE_REFERENCE_A' &&
  readFileSync(join(process.cwd(), 'references', 'z-last.md'), 'utf8') ===
    'INLINE_REFERENCE_Z' &&
  readFileSync(join(process.cwd(), 'assets', 'a-first.txt'), 'utf8') === 'INLINE_ASSET_A' &&
  readFileSync(join(process.cwd(), 'assets', 'z-last.txt'), 'utf8') === 'INLINE_ASSET_Z' &&
  readFileSync(join(process.cwd(), 'scripts', 'a-helper.mjs'), 'utf8') ===
    '// INLINE_HELPER_A' &&
  readFileSync(join(process.cwd(), 'scripts', 'z-helper.mjs'), 'utf8') === '// INLINE_HELPER_Z';
if (process.env.MANEE_SKILL_CLEANUP_PROBE) {
  appendFileSync(process.env.MANEE_SKILL_CLEANUP_PROBE, process.cwd() + '\\n');
}
process.stdout.write(
  JSON.stringify({
    argv,
    guide,
    payload,
    cwdBase: basename(process.cwd()),
    skillDocumentMatches: skillDocument === ${JSON.stringify(inlineSkillDocument)},
    completeTree,
  }),
);
if (argv[0] === '--fail') {
  process.stderr.write('EXPECTED_INLINE_NONZERO_EXIT');
  process.exitCode = 7;
}
`,
    },
    'a-helper': {
      extension: '.mjs',
      content: '// INLINE_HELPER_A',
    },
  },
};

class QueueChatModel extends OpenAIChatModel {
  readonly requests: ModelGenerateRequest<OpenAIChatProtocol>[] = [];

  constructor(private readonly entries: GenerateEntry[] = []) {
    super({ apiKey: 'offline-skills-demo-key', model: 'offline-skills-demo-model' });
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
    assertDemo(entry, 'offline model response queue must not be empty');

    return typeof entry === 'function' ? entry(snapshot, this.requests.length) : entry;
  }
}

await runScenario('progressive disclosure + inline/file load/read/run', async () => {
  const cleanupProbeRoot = mkdtempSync(join(tmpdir(), 'manee-skill-cleanup-probe-'));
  const cleanupProbePath = join(cleanupProbeRoot, 'materialized-cwds.txt');
  const fileExecutionProbePath = join(cleanupProbeRoot, 'file-execution.jsonl');
  const previousCleanupProbe = process.env.MANEE_SKILL_CLEANUP_PROBE;
  const previousFileExecutionProbe = process.env.MANEE_FILE_SKILL_EXECUTION_PROBE;
  const cleanupProbe = (): void => {
    if (previousCleanupProbe === undefined) {
      delete process.env.MANEE_SKILL_CLEANUP_PROBE;
    } else {
      process.env.MANEE_SKILL_CLEANUP_PROBE = previousCleanupProbe;
    }
    if (previousFileExecutionProbe === undefined) {
      delete process.env.MANEE_FILE_SKILL_EXECUTION_PROBE;
    } else {
      process.env.MANEE_FILE_SKILL_EXECUTION_PROBE = previousFileExecutionProbe;
    }
    rmSync(cleanupProbeRoot, { recursive: true, force: true });
  };

  process.once('exit', cleanupProbe);
  process.env.MANEE_SKILL_CLEANUP_PROBE = cleanupProbePath;
  process.env.MANEE_FILE_SKILL_EXECUTION_PROBE = fileExecutionProbePath;
  const model = new QueueChatModel([
    calls(
      rawCall(
        'inline-load',
        'skill',
        JSON.stringify({ skill: 'inline-inspector', args: 'load alpha  tail  ' }),
      ),
      rawCall('file-load', 'skill', JSON.stringify({ skill: 'portable-demo' })),
    ),
    calls(
      rawCall(
        'inline-read-guide',
        'skill',
        JSON.stringify({
          skill: 'inline-inspector',
          args: 'read references/guide.md',
        }),
      ),
      rawCall(
        'inline-read-asset',
        'skill',
        JSON.stringify({ skill: 'inline-inspector', args: 'read assets/payload.txt' }),
      ),
      rawCall(
        'file-read-guide',
        'skill',
        JSON.stringify({ skill: 'portable-demo', args: 'read references/guide.md' }),
      ),
      rawCall(
        'file-read-asset',
        'skill',
        JSON.stringify({ skill: 'portable-demo', args: 'read assets/payload.txt' }),
      ),
    ),
    calls(
      rawCall(
        'inline-run',
        'skill',
        JSON.stringify({
          skill: 'inline-inspector',
          args: 'run scripts/inspect.mjs "two words" "semi;pipe|redirect>star*" \'$HOME\'',
        }),
      ),
      rawCall(
        'inline-run-nonzero',
        'skill',
        JSON.stringify({
          skill: 'inline-inspector',
          args: 'run scripts/inspect.mjs --fail',
        }),
      ),
      rawCall(
        'file-run',
        'skill',
        JSON.stringify({
          skill: 'portable-demo',
          args: 'run scripts/inspect.mjs "file argument"',
        }),
      ),
    ),
    calls(rawCall('end', 'end-agent')),
  ]);
  const descriptorSnapshots: Array<readonly AgentSkillDescriptor[]> = [];
  const observer: ToolRuntimeDefinition = {
    name: 'skill-descriptor-observer',
    description(context) {
      descriptorSnapshots.push(context.skills);
      return 'Observe the descriptor-only Skill view.';
    },
    parameters: z.object({}),
    handler: () => 'unused',
  };
  const agent = new Agent<OpenAIChatProtocol>({
    llm: model,
    maxIterations: 6,
    skills: [inlineInspector, { source: 'file', path: fixtureRoot }],
    skillRuntime: {
      scripts: {
        executors: {
          '.mjs': { command: process.execPath },
        },
      },
    },
  });

  agent.tools.push(observer);
  agent.init();
  const diagnostics = agent.getSkillSourceDiagnostics();
  assertDeepEqual(diagnostics, [], 'portable file source should initialize without diagnostics');
  assertDemo(Object.isFrozen(diagnostics), 'diagnostic snapshot should be frozen');

  const context = await agent.agent('Run the deterministic Skills acceptance flow.');
  assertDemo(model.requests.length === 4, 'progressive flow should use four model turns');

  const firstRequest = model.requests[0];
  assertDemo(firstRequest, 'first model request should exist');
  const firstWireSnapshot = JSON.stringify(firstRequest);
  for (const disclosedLater of [
    inlineInstructions,
    inlineGuide,
    inlinePayload,
    inlineScriptMarker,
    'INLINE_REFERENCE_A',
    'INLINE_REFERENCE_Z',
    'INLINE_ASSET_A',
    'INLINE_ASSET_Z',
    'INLINE_HELPER_A',
    'INLINE_HELPER_Z',
    'INLINE_PRIVATE_LICENSE',
    'INLINE_PRIVATE_COMPATIBILITY',
    'INLINE_PRIVATE_OWNER',
    'PORTABLE_FILE_INSTRUCTIONS',
    'PORTABLE_ASSET_PAYLOAD',
    'PORTABLE_ASSET_A',
    'PORTABLE_ASSET_Z',
    'PORTABLE_SCRIPT_SOURCE_MARKER',
    'Portable helper used to verify deterministic script ordering',
    'This file exists to verify deterministic portable resource ordering.',
    'references/guide.md',
    'scripts/inspect.mjs',
    fixtureRoot,
    process.execPath,
  ]) {
    assertDemo(
      !firstWireSnapshot.includes(disclosedLater),
      `first request must not disclose ${disclosedLater}`,
    );
  }
  assertDemo(
    firstWireSnapshot.includes('inline-inspector'),
    'first request should disclose inline name',
  );
  assertDemo(
    firstWireSnapshot.includes(inlineInspector.description),
    'first request should disclose inline description',
  );
  assertDemo(
    firstWireSnapshot.includes('portable-demo'),
    'first request should disclose file name',
  );

  assertDemo(
    descriptorSnapshots.length === model.requests.length,
    'dynamic tool description should receive one descriptor snapshot per request',
  );
  for (const descriptors of descriptorSnapshots) {
    assertDemo(Object.isFrozen(descriptors), 'descriptor array should be frozen');
    assertDemo(descriptors.every(Object.isFrozen), 'each descriptor should be frozen');
    assertDeepEqual(
      descriptors,
      [
        { name: 'inline-inspector', description: inlineInspector.description },
        {
          name: 'portable-demo',
          description: 'Demonstrates portable text resources and a Node script from a file Skill.',
        },
      ],
      'dynamic descriptions should receive name + description only',
    );
    assertDemo(
      descriptors.every((descriptor) => Object.keys(descriptor).join(',') === 'name,description'),
      'descriptor objects must expose exactly name and description',
    );
  }

  const inlineLoad = readToolOutput(context, 'inline-load');
  assertDemo(
    inlineLoad.includes('Arguments=alpha  tail  \n'),
    'load should preserve trailing arguments',
  );
  assertDemo(
    inlineLoad.includes(
      [
        '## Resources',
        '- assets/a-first.txt',
        '- assets/payload.txt',
        '- assets/z-last.txt',
        '- references/a-first.md',
        '- references/guide.md',
        '- references/z-last.md',
        '',
        '## Scripts',
        '- scripts/a-helper.mjs [available]',
        '- scripts/inspect.mjs [available] — "Inspect argv and materialized resources."',
        '- scripts/z-helper.mjs [available]',
      ].join('\n'),
    ),
    'inline load should reveal a stable, sorted manifest',
  );
  assertDemo(!inlineLoad.includes(inlineGuide), 'load must not reveal resource content');
  assertDemo(!inlineLoad.includes(inlineScriptMarker), 'load must not reveal script source');

  const fileLoad = readToolOutput(context, 'file-load');
  assertDemo(fileLoad.includes('PORTABLE_FILE_INSTRUCTIONS'), 'file load should reveal body');
  assertDemo(
    fileLoad.includes(
      [
        '## Resources',
        '- assets/a-first.txt',
        '- assets/payload.txt',
        '- assets/z-last.txt',
        '- references/a-first.md',
        '- references/guide.md',
        '- references/z-last.md',
        '',
        '## Scripts',
        '- scripts/a-helper.mjs [available]',
        '- scripts/inspect.mjs [available]',
        '- scripts/z-helper.mjs [available]',
      ].join('\n'),
    ),
    'file load should reveal a stable, sorted manifest',
  );
  assertDemo(
    !fileLoad.includes('PORTABLE_ASSET_PAYLOAD'),
    'file load must not reveal asset content',
  );

  assertDemo(readToolOutput(context, 'inline-read-guide') === inlineGuide, 'inline reference read');
  assertDemo(readToolOutput(context, 'inline-read-asset') === inlinePayload, 'inline asset read');
  assertDemo(
    readToolOutput(context, 'file-read-guide').includes('# Portable demo guide'),
    'file reference read',
  );
  assertDemo(
    readToolOutput(context, 'file-read-asset').trim() === 'PORTABLE_ASSET_PAYLOAD',
    'file asset read',
  );

  const inlineRun = parseScriptResult(context, 'inline-run');
  const inlineOutput = parseJson<InspectorOutput>(inlineRun.stdout, 'inline inspector stdout');
  assertDeepEqual(
    inlineOutput.argv,
    ['two words', 'semi;pipe|redirect>star*', '$HOME'],
    'run argv should not receive Shell expansion',
  );
  assertDemo(
    inlineOutput.guide === inlineGuide,
    'inline script should read materialized reference',
  );
  assertDemo(
    inlineOutput.payload === inlinePayload,
    'inline script should read materialized asset',
  );
  assertDemo(inlineOutput.cwdBase === 'inline-inspector', 'inline script cwd should be Skill root');
  assertDemo(
    inlineOutput.skillDocumentMatches,
    'inline materialization should preserve the complete generated SKILL.md',
  );
  assertDemo(inlineOutput.completeTree, 'inline materialization should include the complete tree');
  assertDeepEqual(
    { exitCode: inlineRun.exitCode, signal: inlineRun.signal, stderr: inlineRun.stderr },
    { exitCode: 0, signal: null, stderr: '' },
    'inline script should exit successfully',
  );

  const inlineFailure = parseScriptResult(context, 'inline-run-nonzero');
  assertDeepEqual(
    {
      exitCode: inlineFailure.exitCode,
      signal: inlineFailure.signal,
      stderr: inlineFailure.stderr,
    },
    { exitCode: 7, signal: null, stderr: 'EXPECTED_INLINE_NONZERO_EXIT' },
    'nonzero script exit should remain a structured result',
  );

  const fileRun = parseScriptResult(context, 'file-run');
  const fileOutput = parseJson<InspectorOutput>(fileRun.stdout, 'file inspector stdout');
  assertDeepEqual(fileOutput.argv, ['file argument'], 'file script argv');
  assertDemo(fileOutput.cwdBase === 'portable-demo', 'file script cwd should be file Skill root');
  assertDemo(fileOutput.payload === 'PORTABLE_ASSET_PAYLOAD', 'file script should read asset');
  const fileExecutionProbe = parseJson<FileExecutionProbe>(
    readFileSync(fileExecutionProbePath, 'utf8').trim(),
    'file execution side-channel probe',
  );
  assertDemo(
    fileExecutionProbe.scriptUrl ===
      pathToFileURL(join(fixtureRoot, 'scripts', 'inspect.mjs')).href,
    'file script should execute directly from the registered source tree',
  );
  assertDemo(
    fileExecutionProbe.cwd === fixtureRoot,
    'file script should use the registered Skill root as cwd',
  );

  const materializedCwds = [
    inlineOutput,
    parseJson<InspectorOutput>(inlineFailure.stdout, 'nonzero stdout'),
  ].map((output) => output.cwdBase);
  assertDeepEqual(
    materializedCwds,
    ['inline-inspector', 'inline-inspector'],
    'each inline run should use an isolated Skill root',
  );
  const materializedPaths = readFileSync(cleanupProbePath, 'utf8').trim().split('\n');
  assertDemo(materializedPaths.length === 2, 'each inline run should record its materialized cwd');
  assertDemo(
    new Set(materializedPaths).size === materializedPaths.length,
    'consecutive inline runs should use unique temporary directories',
  );
  assertDemo(
    materializedPaths.every((path) => !existsSync(path)),
    'inline temporary Skill directories should be cleaned after process close',
  );
  assertNoStringLeaks(
    [model.requests, context, agent.getHistory()],
    [fixtureRoot, process.execPath, cleanupProbePath, fileExecutionProbePath, ...materializedPaths],
    'model requests and stored context must not expose source, executable, or temporary paths',
  );
  process.off('exit', cleanupProbe);
  cleanupProbe();
});

await runScenario('dispatch errors + standalone calls', async () => {
  let inputCompactions = 0;
  let resultCompactions = 0;
  const agent = new Agent<OpenAIChatProtocol>({
    llm: new QueueChatModel(),
    skills: [inlineInspector],
    skillRuntime: { compactResult: true },
    contextCompact: {
      toolInput: () => {
        inputCompactions += 1;
        return '[unexpected standalone input compact]';
      },
      toolResult: () => {
        resultCompactions += 1;
        return '[unexpected standalone result compact]';
      },
    },
  });
  agent.init();

  const loaded = await standaloneSkillCall(agent, 'standalone-load', 'inline-inspector');
  assertDemo(
    loaded.includes(inlineInstructions.split(' Arguments=')[0] ?? ''),
    'omitted args = load',
  );
  assertDemo(
    (await standaloneSkillCall(
      agent,
      'standalone-read',
      'inline-inspector',
      'read references/guide.md',
    )) === inlineGuide,
    'standalone read should return exact resource text',
  );
  const nbsp = '\u00a0';
  const nbspLoad = await standaloneSkillCall(
    agent,
    'standalone-nbsp-load',
    'inline-inspector',
    `load alpha${nbsp}beta`,
  );
  assertDemo(
    nbspLoad.includes(`Arguments=alpha${nbsp}beta`),
    'NBSP should remain load argument data',
  );

  const errors = [
    await standaloneSkillCall(agent, 'missing-skill', 'does-not-exist'),
    await standaloneSkillCall(
      agent,
      'missing-resource',
      'inline-inspector',
      'read references/missing.md',
    ),
    await standaloneSkillCall(
      agent,
      'missing-script',
      'inline-inspector',
      'run scripts/missing.mjs',
    ),
    await standaloneSkillCall(agent, 'invalid-read', 'inline-inspector', 'read'),
    await standaloneSkillCall(agent, 'invalid-command', 'inline-inspector', 'dance now'),
    await standaloneSkillCall(
      agent,
      'invalid-quote',
      'inline-inspector',
      'run scripts/inspect.mjs "open',
    ),
    await standaloneSkillCall(
      agent,
      'scripts-disabled',
      'inline-inspector',
      'run scripts/inspect.mjs',
    ),
  ].map((output) => parseJson<SkillDispatchError>(output, 'Skill dispatch error'));
  assertDeepEqual(
    errors.map((error) => error.error.code),
    [
      'skill_not_found',
      'resource_not_found',
      'script_not_found',
      'invalid_arguments',
      'invalid_command',
      'invalid_arguments',
      'script_execution_unavailable',
    ],
    'correctable dispatch errors should expose stable codes',
  );
  assertDemo(
    errors.every((error) => error.ok === false),
    'dispatch errors should be structured',
  );
  assertDemo(inputCompactions === 0, 'standalone calls must not compact input');
  assertDemo(resultCompactions === 0, 'standalone calls must not compact result');
  assertDemo(
    agent.getContext().length === agent.getHistory().length,
    'standalone raw and active histories should remain aligned',
  );
  agent.getContext().forEach((message, index) => {
    assertDemo(
      message === agent.getHistory()[index],
      'standalone raw/active entries should share identity',
    );
  });
});

await runScenario('runtime error sanitization', async () => {
  const temporaryParent = mkdtempSync(join(tmpdir(), 'manee-skills-offline-'));
  const root = join(temporaryParent, 'runtime-failure');
  const references = join(root, 'references');
  const resourcePath = join(references, 'volatile.md');

  try {
    mkdirSync(references, { recursive: true });
    writeFileSync(
      join(root, 'SKILL.md'),
      [
        '---',
        'name: runtime-failure',
        'description: Demonstrates a lazy file read failure.',
        '---',
        'Read the volatile resource.',
      ].join('\n'),
    );
    writeFileSync(resourcePath, 'VOLATILE_CONTENT');

    let modelVisibleResult: string | undefined;
    const model = new QueueChatModel([
      calls(
        rawCall(
          'runtime-read-failure',
          'skill',
          JSON.stringify({
            skill: 'runtime-failure',
            args: 'read references/volatile.md',
          }),
        ),
      ),
      (request) => {
        modelVisibleResult = readToolOutput(request.context, 'runtime-read-failure');
        assertNoStringLeaks(
          request,
          [root, resourcePath, 'ENOENT'],
          'the next model request must receive only the sanitized runtime error',
        );
        return calls(rawCall('runtime-error-end', 'end-agent'));
      },
    ]);
    const agent = new Agent<OpenAIChatProtocol>({
      llm: model,
      skills: [{ source: 'file', path: root }],
    });
    let observedError: unknown;
    agent.onToolCallError((_name, trigger, error) => {
      assertDemo(trigger === 'calling', 'runtime error should use calling trigger');
      observedError = error;
    });
    agent.init();
    unlinkSync(resourcePath);

    const context = await agent.agent('Exercise a runtime Skill failure through the model loop.');
    assertDemo(model.requests.length === 2, 'runtime failure should be visible on the next turn');
    assertDemo(observedError instanceof Error, 'listener should receive a typed Error wrapper');
    assertDemo(
      observedError.constructor.name === 'SkillRuntimeError',
      'wrapper should be SkillRuntimeError',
    );
    const wrapper = observedError as Error & {
      cause?: unknown;
      stage?: unknown;
      skill?: unknown;
      target?: unknown;
    };
    assertDeepEqual(
      { stage: wrapper.stage, skill: wrapper.skill, target: wrapper.target },
      {
        stage: 'resource-read',
        skill: 'runtime-failure',
        target: 'references/volatile.md',
      },
      'runtime wrapper should retain logical provenance',
    );
    assertDemo(wrapper.cause instanceof Error, 'wrapper cause should retain original file error');
    assertDemo(
      (wrapper.cause as Error & { code?: string }).code === 'ENOENT',
      'wrapper cause should retain original error code',
    );
    assertDemo(
      modelVisibleResult === wrapper.message,
      'the next model request should use the sanitized wrapper message',
    );
    assertDemo(
      readToolOutput(context, 'runtime-read-failure') === modelVisibleResult,
      'active history should retain the same sanitized tool result',
    );
    assertDemo(
      readToolOutput(agent.getHistory(), 'runtime-read-failure') === modelVisibleResult,
      'raw history should retain the sanitized tool result exactly',
    );
  } finally {
    rmSync(temporaryParent, { recursive: true, force: true });
  }
});

await runScenario('running Registry snapshot + re-init', async () => {
  let markStarted!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const model = new QueueChatModel([
    async () => {
      markStarted();
      await held;
      return calls(
        rawCall('lifecycle-existing-skill', 'skill', JSON.stringify({ skill: 'inline-inspector' })),
      );
    },
    (request) => {
      assertDemo(
        !JSON.stringify(request).includes('late-skill'),
        'a request built after addSkill() must retain the running Registry snapshot',
      );
      assertDemo(
        readToolOutput(request.context, 'lifecycle-existing-skill').includes(
          'INLINE_PRIVATE_INSTRUCTIONS',
        ),
        'the old Registry should remain executable after addSkill() during a run',
      );
      return calls(rawCall('lifecycle-end', 'end-agent'));
    },
  ]);
  const lateSkill: AgentSkill = {
    name: 'late-skill',
    description: 'Added while the Agent is running.',
    instructions: 'LATE_SKILL_INSTRUCTIONS',
  };
  const agent = new Agent<OpenAIChatProtocol>({ llm: model, skills: [inlineInspector] });
  agent.init();

  const running = agent.agent('Hold the first model request.');
  await started;
  agent.addSkill(lateSkill);
  assertThrows(() => agent.init(), /while it is running/iu, 'init must reject while running');
  const runningPrompt = JSON.stringify(model.requests[0]);
  assertDemo(
    !runningPrompt.includes('late-skill'),
    'current run should retain the old Registry snapshot',
  );
  release();
  await running;
  assertDemo(model.requests.length === 2, 'running snapshot flow should build a post-add request');
  assertDemo(
    !JSON.stringify(model.requests[1]).includes('late-skill'),
    'the post-add request should still use the old Registry snapshot',
  );

  await assertRejects(
    agent.toolCall(parsedCall('late-before-init', 'skill', { skill: 'late-skill' })),
    /not been initialized/iu,
    'dirty Registry should require re-init after the run',
  );
  agent.init();
  const loaded = await standaloneSkillCall(agent, 'late-after-init', 'late-skill');
  assertDemo(loaded.includes('LATE_SKILL_INSTRUCTIONS'), 'late Skill should appear after re-init');
});

await runScenario('Skill-specific payload compact policy', async () => {
  const defaultResultCalls: string[] = [];
  const defaultInputCalls: string[] = [];
  const model = new QueueChatModel([
    calls(
      rawCall('compact-skill-default', 'skill', JSON.stringify({ skill: 'inline-inspector' })),
      rawCall('compact-ordinary', 'ordinary', JSON.stringify({ value: 'original' })),
    ),
  ]);
  const inputCompactor: ToolPayloadCompactor = (_original, info) => {
    defaultInputCalls.push(info.call.name);
    return JSON.stringify({ compacted: info.call.name });
  };
  const resultCompactor: ToolPayloadCompactor = (_original, info) => {
    defaultResultCalls.push(info.call.name);
    return `[compacted result:${info.call.name}]`;
  };
  const agent = new Agent<OpenAIChatProtocol>({
    llm: model,
    maxIterations: 1,
    skills: [inlineInspector],
    contextCompact: { toolInput: inputCompactor, toolResult: resultCompactor },
  });
  agent.tools.push({
    name: 'ordinary',
    description: 'Return an ordinary result eligible for compaction.',
    parameters: z.object({ value: z.string() }),
    handler: () => 'ORDINARY_RESULT',
  });
  agent.init();
  await assertRejects(
    agent.agent('Run one compact loop.'),
    /exceeded maxIterations/iu,
    'one-loop compact demo should stop at its explicit bound',
  );

  assertDeepEqual(
    defaultInputCalls,
    ['skill', 'ordinary'],
    'Skill and ordinary inputs should both be compact eligible',
  );
  assertDeepEqual(defaultResultCalls, ['ordinary'], 'Skill result should opt out by default');
  assertDemo(
    readToolArguments(agent.getHistory(), 'compact-skill-default') ===
      JSON.stringify({ skill: 'inline-inspector' }),
    'raw Skill input should remain original',
  );
  assertDemo(
    readToolArguments(agent.getContext(), 'compact-skill-default') ===
      JSON.stringify({ compacted: 'skill' }),
    'active Skill input should use replacement',
  );
  assertDemo(
    readToolOutput(agent.getContext(), 'compact-skill-default') ===
      readToolOutput(agent.getHistory(), 'compact-skill-default'),
    'default Skill result should remain unchanged in active context',
  );
  assertDemo(
    readToolOutput(agent.getContext(), 'compact-ordinary') === '[compacted result:ordinary]',
    'ordinary result should compact',
  );

  let explicitResultCalls = 0;
  const explicit = new Agent<OpenAIChatProtocol>({
    llm: new QueueChatModel([
      calls(
        rawCall('compact-skill-explicit', 'skill', JSON.stringify({ skill: 'inline-inspector' })),
      ),
    ]),
    maxIterations: 1,
    skills: [inlineInspector],
    skillRuntime: { compactResult: true },
    contextCompact: {
      toolInput: false,
      toolResult: () => {
        explicitResultCalls += 1;
        return '[compacted Skill result]';
      },
    },
  });
  explicit.init();
  await assertRejects(
    explicit.agent('Run explicit Skill result compact.'),
    /exceeded maxIterations/iu,
    'explicit compact demo should stop at its bound',
  );
  assertDemo(explicitResultCalls === 1, 'compactResult=true should enable Skill result compactor');
  assertDemo(
    readToolOutput(explicit.getContext(), 'compact-skill-explicit') === '[compacted Skill result]',
    'active Skill result should be replaced when explicitly enabled',
  );
  assertDemo(
    readToolOutput(explicit.getHistory(), 'compact-skill-explicit').includes(
      'INLINE_PRIVATE_INSTRUCTIONS',
    ),
    'raw Skill result should remain original after explicit compact',
  );
});

console.log('Skills offline feature suite complete.');

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
  input: Readonly<Record<string, unknown>> = {},
): AgentToolCall<OpenAIChatProtocol> {
  const argumentsText = JSON.stringify(input);
  const sourceCall = rawCall(id, name, argumentsText);
  const sourceMessage = calls(sourceCall).messages[0] as OpenAIChatContext;

  return {
    id,
    name,
    arguments: argumentsText,
    sourceCall,
    sourceMessage,
  };
}

async function standaloneSkillCall(
  agent: Agent<OpenAIChatProtocol>,
  id: string,
  skill: string,
  args?: string,
): Promise<string> {
  const message = await agent.toolCall(
    parsedCall(id, 'skill', { skill, ...(args === undefined ? {} : { args }) }),
  );

  return readToolMessageContent(message, id);
}

function readToolOutput(context: readonly OpenAIChatContext[], id: string): string {
  const message = context.find(
    (candidate) => candidate.role === 'tool' && candidate.tool_call_id === id,
  );
  assertDemo(message, `tool output ${id} should exist`);
  return readToolMessageContent(message, id);
}

function readToolMessageContent(message: OpenAIChatContext, id: string): string {
  assertDemo(message.role === 'tool', `${id} should be a Chat tool message`);
  assertDemo(typeof message.content === 'string', `${id} tool output should be a string`);
  return message.content;
}

function readToolArguments(context: readonly OpenAIChatContext[], id: string): string {
  for (const message of context) {
    if (message.role !== 'assistant') continue;
    const call = message.tool_calls?.find(
      (candidate): candidate is OpenAIChatRawToolCall =>
        candidate.type === 'function' && candidate.id === id,
    );
    if (call) return call.function.arguments;
  }
  throw new Error(`[Skills offline assertion failed] tool arguments ${id} should exist`);
}

function parseScriptResult(context: readonly OpenAIChatContext[], id: string): ScriptResult {
  return parseJson<ScriptResult>(readToolOutput(context, id), `${id} script result`);
}

function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new Error(`[Skills offline assertion failed] ${label} should be JSON`, { cause: error });
  }
}

async function runScenario(name: string, run: () => Promise<void>): Promise<void> {
  await run();
  console.log(`PASS ${name}`);
}

function assertDemo(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[Skills offline assertion failed] ${message}`);
  }
}

function assertDeepEqual(actual: unknown, expected: unknown, message: string): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  assertDemo(
    actualJson === expectedJson,
    `${message}: expected ${expectedJson}, received ${actualJson}`,
  );
}

function assertNoStringLeaks(
  value: unknown,
  hiddenValues: readonly string[],
  message: string,
): void {
  const seen = new WeakSet<object>();

  const visit = (candidate: unknown): void => {
    if (typeof candidate === 'string') {
      assertDemo(
        hiddenValues.every((hidden) => hidden.length === 0 || !candidate.includes(hidden)),
        message,
      );
      return;
    }
    if (typeof candidate !== 'object' || candidate === null || seen.has(candidate)) {
      return;
    }

    seen.add(candidate);
    for (const [key, child] of Object.entries(candidate)) {
      visit(key);
      visit(child);
    }
  };

  visit(value);
}

function assertThrows(run: () => unknown, pattern: RegExp, message: string): void {
  try {
    run();
  } catch (error) {
    assertDemo(error instanceof Error && pattern.test(error.message), message);
    return;
  }
  throw new Error(`[Skills offline assertion failed] ${message}`);
}

async function assertRejects(
  promise: Promise<unknown>,
  pattern: RegExp,
  message: string,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    assertDemo(error instanceof Error && pattern.test(error.message), message);
    return;
  }
  throw new Error(`[Skills offline assertion failed] ${message}`);
}
