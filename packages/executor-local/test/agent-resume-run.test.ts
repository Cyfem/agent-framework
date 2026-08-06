import { describe, expect, vi } from 'vitest';
import { z } from 'zod';

import {
  Agent,
  createSubAgentRuntime,
  defineSubAgent,
  OpenAIChatModel,
  type JsonValue,
  type OpenAIChatProtocol,
} from '@ruixutong.manee/maneeagent-framework';

import { Deferred, acceptanceIt } from '../../../testkit';
import {
  createLocalAgentRunnerRegistration,
  LocalSubAgentRunnerRegistry,
  MemoryAgentRuntimeStateStore,
  MemorySubAgentExecutor,
} from '../src';

const approvalDefinition = defineSubAgent({
  name: 'approval-proof',
  version: '2',
  description: 'Exercise the public root approval and resume lifecycle.',
  inputSchema: z.object({ prompt: z.string() }).strict(),
  outputSchema: z.object({ answer: z.string() }).strict(),
});

const nestedLeafDefinition = defineSubAgent({
  name: 'nested-approval-leaf',
  version: '2',
  description: 'Leaf Agent that proves delegated approval recovery.',
  inputSchema: z.object({ prompt: z.string() }).strict(),
  outputSchema: z.object({ answer: z.string() }).strict(),
});

const nestedCoordinatorDefinition = defineSubAgent({
  name: 'nested-approval-coordinator',
  version: '2',
  description: 'Coordinator Agent that delegates to the approval leaf.',
  inputSchema: z.object({ prompt: z.string() }).strict(),
  outputSchema: z.object({ answer: z.string() }).strict(),
  delegation: { mode: 'allowlist', definitions: [nestedLeafDefinition.name] },
});

const staggeredFirstDefinition = defineSubAgent({
  name: 'staggered-first-worker',
  version: '2',
  description: 'First independently approved sibling.',
  inputSchema: z.object({ prompt: z.string() }).strict(),
  outputSchema: z.object({ answer: z.string() }).strict(),
});

const staggeredSecondDefinition = defineSubAgent({
  name: 'staggered-second-worker',
  version: '2',
  description: 'Second sibling whose approval arrives after the first root pause.',
  inputSchema: z.object({ prompt: z.string() }).strict(),
  outputSchema: z.object({ answer: z.string() }).strict(),
});

const nestedStaggeredFirstDefinition = defineSubAgent({
  name: 'nested-staggered-first-leaf',
  version: '2',
  description: 'First nested leaf whose approval pauses the coordinator.',
  inputSchema: z.object({ prompt: z.string() }).strict(),
  outputSchema: z.object({ answer: z.string() }).strict(),
});

const nestedStaggeredSecondDefinition = defineSubAgent({
  name: 'nested-staggered-second-leaf',
  version: '2',
  description: 'Second nested leaf whose approval arrives after the coordinator pauses.',
  inputSchema: z.object({ prompt: z.string() }).strict(),
  outputSchema: z.object({ answer: z.string() }).strict(),
});

const nestedStaggeredCoordinatorDefinition = defineSubAgent({
  name: 'nested-staggered-coordinator',
  version: '2',
  description: 'Coordinator that recovers two nested approval rounds without replay.',
  inputSchema: z.object({ prompt: z.string() }).strict(),
  outputSchema: z.object({ answer: z.string() }).strict(),
  delegation: {
    mode: 'allowlist',
    definitions: [nestedStaggeredFirstDefinition.name, nestedStaggeredSecondDefinition.name],
  },
});

describe('public Agent approval resume lifecycle', () => {
  acceptanceIt(
    'BATCH-01.l4.staggered-sibling-approval.local',
    'chat-local-multi-round-authoritative-resume',
    async () => {
      const sessionId = 'staggered-root-sibling-approvals';
      const executorName = 'local-staggered-siblings';
      const stateStore = new MemoryAgentRuntimeStateStore();
      const releaseSecondModel = new Deferred<void>();
      const secondModelEntered = new Deferred<void>();
      const firstHandler = vi.fn(() => 'first-approved-marker');
      const secondHandler = vi.fn(() => 'second-approved-marker');
      const firstCreate = vi
        .fn()
        .mockImplementationOnce(async () => {
          await secondModelEntered.promise;
          return chatToolResponse('first-sensitive-call', 'first-sensitive-proof', {
            marker: 'safe',
          });
        })
        .mockResolvedValueOnce(
          chatToolResponse('first-result-call', 'agent-result', {
            result: { answer: 'first-sibling-proof' },
          }),
        )
        .mockResolvedValueOnce(chatToolResponse('first-end-call', 'end-agent', {}));
      const secondCreate = vi
        .fn()
        .mockImplementationOnce(async () => {
          secondModelEntered.resolve(undefined);
          await releaseSecondModel.promise;
          return chatToolResponse('second-sensitive-call', 'second-sensitive-proof', {
            marker: 'safe',
          });
        })
        .mockResolvedValueOnce(
          chatToolResponse('second-result-call', 'agent-result', {
            result: { answer: 'second-sibling-proof' },
          }),
        )
        .mockResolvedValueOnce(chatToolResponse('second-end-call', 'end-agent', {}));

      const registrations = [
        createLocalAgentRunnerRegistration({
          definition: staggeredFirstDefinition,
          runnerId: 'staggered-first-runner',
          runnerVersion: '2.0.0',
          createAgent() {
            const child = new Agent<OpenAIChatProtocol>({
              llm: createChatModel('offline-staggered-first', firstCreate),
              maxIterations: 4,
            });
            child.tools.push({
              name: 'first-sensitive-proof',
              description: 'First deterministic approval Tool.',
              parameters: z.object({ marker: z.literal('safe') }).strict(),
              approval: { summary: 'Approve the first sibling proof.', expiresInMs: 60_000 },
              handler: firstHandler,
            });
            return child;
          },
          buildInput: ({ input }) => input.prompt,
        }),
        createLocalAgentRunnerRegistration({
          definition: staggeredSecondDefinition,
          runnerId: 'staggered-second-runner',
          runnerVersion: '2.0.0',
          createAgent() {
            const child = new Agent<OpenAIChatProtocol>({
              llm: createChatModel('offline-staggered-second', secondCreate),
              maxIterations: 4,
            });
            child.tools.push({
              name: 'second-sensitive-proof',
              description: 'Second deterministic approval Tool.',
              parameters: z.object({ marker: z.literal('safe') }).strict(),
              approval: { summary: 'Approve the second sibling proof.', expiresInMs: 60_000 },
              handler: secondHandler,
            });
            return child;
          },
          buildInput: ({ input }) => input.prompt,
        }),
      ];
      const registry = new LocalSubAgentRunnerRegistry(registrations);
      const createRuntime = async () => {
        const runtime = createSubAgentRuntime({
          sessionId,
          activeDefinitions: [staggeredFirstDefinition, staggeredSecondDefinition],
          executors: [new MemorySubAgentExecutor({ name: executorName, registry })],
          stateStore,
        });
        await runtime.init();
        return runtime;
      };
      let parentResultRequest: unknown;
      const parentCreate = vi.fn(async (request: unknown) => {
        const round = parentCreate.mock.calls.length;
        if (round === 1) {
          return chatToolCallsResponse([
            {
              callId: 'parent-first-agent',
              name: 'agent',
              parameters: {
                subAgent: staggeredFirstDefinition.name,
                executor: executorName,
                input: { prompt: 'first' },
              },
            },
            {
              callId: 'parent-second-agent',
              name: 'agent',
              parameters: {
                subAgent: staggeredSecondDefinition.name,
                executor: executorName,
                input: { prompt: 'second' },
              },
            },
          ]);
        }
        if (round === 2) {
          parentResultRequest = request;
          return chatToolResponse('parent-staggered-end', 'end-agent', {});
        }
        throw new Error(`Unexpected staggered parent provider round ${round}.`);
      });
      const createParent = async () => {
        const agent = new Agent<OpenAIChatProtocol>({
          llm: createChatModel('offline-staggered-parent', parentCreate),
          subAgentRuntime: await createRuntime(),
          sessionId,
          maxIterations: 3,
        });
        return agent.init();
      };

      const firstWaiting = await (await createParent()).agent('start staggered siblings');
      if (firstWaiting.status !== 'waiting_approval') {
        throw new Error(`expected first sibling approval pause: ${JSON.stringify(firstWaiting)}`);
      }
      expect(firstWaiting.approvals).toHaveLength(1);
      expect(firstWaiting.approvals[0]?.toolName).toBe('first-sensitive-proof');
      expect(parentCreate).toHaveBeenCalledTimes(1);
      const firstPausedTasks = await stateStore.listTasksByRun(sessionId, firstWaiting.runId);
      expect(firstPausedTasks.map(({ state }) => state).sort()).toEqual([
        'running',
        'waiting_approval',
      ]);
      const firstRunRevision = (await stateStore.loadRun(sessionId, firstWaiting.runId))!.revision;

      releaseSecondModel.resolve(undefined);
      await vi.waitFor(async () => {
        const tasks = await stateStore.listTasksByRun(sessionId, firstWaiting.runId);
        expect(tasks.filter(({ state }) => state === 'waiting_approval')).toHaveLength(2);
      });
      const firstApproval = firstWaiting.approvals[0]!;
      const secondWaiting = await (
        await createParent()
      ).resumeRun({
        runId: firstWaiting.runId,
        decisions: [
          {
            approvalId: firstApproval.approvalId,
            decision: 'approved',
            expectedRevision: firstApproval.revision,
          },
        ],
      });
      if (secondWaiting.status !== 'waiting_approval') {
        throw new Error('expected the later sibling approval on the second recovery');
      }
      expect(secondWaiting.approvals).toHaveLength(1);
      expect(secondWaiting.approvals[0]?.toolName).toBe('second-sensitive-proof');
      expect(parentCreate).toHaveBeenCalledTimes(1);
      expect(firstHandler).toHaveBeenCalledOnce();
      expect(secondHandler).not.toHaveBeenCalled();
      const middleTasks = await stateStore.listTasksByRun(sessionId, firstWaiting.runId);
      expect(middleTasks.map(({ state }) => state).sort()).toEqual([
        'succeeded',
        'waiting_approval',
      ]);
      expect((await stateStore.loadRun(sessionId, firstWaiting.runId))!.revision).toBeGreaterThan(
        firstRunRevision,
      );

      const secondApproval = secondWaiting.approvals[0]!;
      const completed = await (
        await createParent()
      ).resumeRun({
        runId: firstWaiting.runId,
        decisions: [
          {
            approvalId: secondApproval.approvalId,
            decision: 'approved',
            expectedRevision: secondApproval.revision,
          },
        ],
      });
      expect(completed).toMatchObject({
        status: 'succeeded',
        runId: firstWaiting.runId,
        sessionId,
      });
      expect(firstHandler).toHaveBeenCalledOnce();
      expect(secondHandler).toHaveBeenCalledOnce();
      expect(parentCreate).toHaveBeenCalledTimes(2);
      expect(firstCreate).toHaveBeenCalledTimes(3);
      expect(secondCreate).toHaveBeenCalledTimes(3);
      expect(
        extractChatToolOutputs(parentResultRequest).map(
          (entry) => (entry as { readonly callId: string }).callId,
        ),
      ).toEqual(['parent-first-agent', 'parent-second-agent']);
      const terminalTasks = await stateStore.listTasksByRun(sessionId, firstWaiting.runId);
      expect(terminalTasks.every(({ state }) => state === 'succeeded')).toBe(true);
      const terminalRunRevision = (await stateStore.loadRun(sessionId, firstWaiting.runId))!
        .revision;
      const terminalTaskState = terminalTasks.map(({ taskId, state, revision, eventSequence }) => ({
        taskId,
        state,
        revision,
        eventSequence,
      }));
      await expect(
        (await createParent()).resumeRun({ runId: firstWaiting.runId, decisions: [] }),
      ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
      expect(parentCreate).toHaveBeenCalledTimes(2);
      expect(firstCreate).toHaveBeenCalledTimes(3);
      expect(secondCreate).toHaveBeenCalledTimes(3);
      expect(firstHandler).toHaveBeenCalledOnce();
      expect(secondHandler).toHaveBeenCalledOnce();
      expect((await stateStore.loadRun(sessionId, firstWaiting.runId))!.revision).toBe(
        terminalRunRevision,
      );
      expect(
        (await stateStore.listTasksByRun(sessionId, firstWaiting.runId)).map(
          ({ taskId, state, revision, eventSequence }) => ({
            taskId,
            state,
            revision,
            eventSequence,
          }),
        ),
      ).toEqual(terminalTaskState);
    },
  );

  acceptanceIt(
    'APP-05.l4.staggered-nested-approval.local',
    'chat-chat-two-leaf-multi-round-resume',
    async () => {
      const sessionId = 'staggered-nested-approvals';
      const executorName = 'local-staggered-nested';
      const stateStore = new MemoryAgentRuntimeStateStore();
      const releaseSecondLeaf = new Deferred<void>();
      const secondLeafEntered = new Deferred<void>();
      const firstHandler = vi.fn(() => 'nested-first-approved-marker');
      const secondHandler = vi.fn(() => 'nested-second-approved-marker');
      const firstLeafCreate = vi
        .fn()
        .mockImplementationOnce(async () => {
          await secondLeafEntered.promise;
          return chatToolResponse('nested-first-sensitive', 'nested-first-sensitive-proof', {
            marker: 'safe',
          });
        })
        .mockResolvedValueOnce(
          chatToolResponse('nested-first-result', 'agent-result', {
            result: { answer: 'nested-first-leaf-proof' },
          }),
        )
        .mockResolvedValueOnce(chatToolResponse('nested-first-end', 'end-agent', {}));
      const secondLeafCreate = vi
        .fn()
        .mockImplementationOnce(async () => {
          secondLeafEntered.resolve(undefined);
          await releaseSecondLeaf.promise;
          return chatToolResponse('nested-second-sensitive', 'nested-second-sensitive-proof', {
            marker: 'safe',
          });
        })
        .mockResolvedValueOnce(
          chatToolResponse('nested-second-result', 'agent-result', {
            result: { answer: 'nested-second-leaf-proof' },
          }),
        )
        .mockResolvedValueOnce(chatToolResponse('nested-second-end', 'end-agent', {}));

      let coordinatorResultRequest: unknown;
      const coordinatorCreate = vi.fn(async (request: unknown) => {
        const round = coordinatorCreate.mock.calls.length;
        if (round === 1) {
          return chatToolCallsResponse([
            {
              callId: 'coordinator-first-leaf',
              name: 'agent',
              parameters: {
                subAgent: nestedStaggeredFirstDefinition.name,
                executor: executorName,
                input: { prompt: 'first nested leaf' },
              },
            },
            {
              callId: 'coordinator-second-leaf',
              name: 'agent',
              parameters: {
                subAgent: nestedStaggeredSecondDefinition.name,
                executor: executorName,
                input: { prompt: 'second nested leaf' },
              },
            },
          ]);
        }
        if (round === 2) {
          coordinatorResultRequest = request;
          return chatToolResponse('staggered-coordinator-result', 'agent-result', {
            result: { answer: 'staggered-coordinator-proof' },
          });
        }
        if (round === 3) {
          return chatToolResponse('staggered-coordinator-end', 'end-agent', {});
        }
        throw new Error(`Unexpected staggered coordinator provider round ${round}.`);
      });

      const registrations = [
        createLocalAgentRunnerRegistration({
          definition: nestedStaggeredFirstDefinition,
          runnerId: 'nested-staggered-first-runner',
          runnerVersion: '2.0.0',
          createAgent() {
            const leaf = new Agent<OpenAIChatProtocol>({
              llm: createChatModel('offline-nested-staggered-first', firstLeafCreate),
              maxIterations: 4,
            });
            leaf.tools.push({
              name: 'nested-first-sensitive-proof',
              description: 'First nested deterministic approval Tool.',
              parameters: z.object({ marker: z.literal('safe') }).strict(),
              approval: { summary: 'Approve the first nested leaf.', expiresInMs: 60_000 },
              handler: firstHandler,
            });
            return leaf;
          },
          buildInput: ({ input }) => input.prompt,
        }),
        createLocalAgentRunnerRegistration({
          definition: nestedStaggeredSecondDefinition,
          runnerId: 'nested-staggered-second-runner',
          runnerVersion: '2.0.0',
          createAgent() {
            const leaf = new Agent<OpenAIChatProtocol>({
              llm: createChatModel('offline-nested-staggered-second', secondLeafCreate),
              maxIterations: 4,
            });
            leaf.tools.push({
              name: 'nested-second-sensitive-proof',
              description: 'Second nested deterministic approval Tool.',
              parameters: z.object({ marker: z.literal('safe') }).strict(),
              approval: { summary: 'Approve the second nested leaf.', expiresInMs: 60_000 },
              handler: secondHandler,
            });
            return leaf;
          },
          buildInput: ({ input }) => input.prompt,
        }),
        createLocalAgentRunnerRegistration({
          definition: nestedStaggeredCoordinatorDefinition,
          runnerId: 'nested-staggered-coordinator-runner',
          runnerVersion: '2.0.0',
          createAgent() {
            return new Agent<OpenAIChatProtocol>({
              llm: createChatModel('offline-nested-staggered-coordinator', coordinatorCreate),
              maxIterations: 4,
            });
          },
          buildInput: ({ input }) => input.prompt,
        }),
      ];
      const registry = new LocalSubAgentRunnerRegistry(registrations);
      const createRuntime = async () => {
        const runtime = createSubAgentRuntime({
          sessionId,
          activeDefinitions: [
            nestedStaggeredCoordinatorDefinition,
            nestedStaggeredFirstDefinition,
            nestedStaggeredSecondDefinition,
          ],
          executors: [new MemorySubAgentExecutor({ name: executorName, registry })],
          stateStore,
        });
        await runtime.init();
        return runtime;
      };

      let parentResultRequest: unknown;
      const parentCreate = vi.fn(async (request: unknown) => {
        const round = parentCreate.mock.calls.length;
        if (round === 1) {
          return chatToolResponse('parent-staggered-coordinator', 'agent', {
            subAgent: nestedStaggeredCoordinatorDefinition.name,
            executor: executorName,
            input: { prompt: 'coordinate two nested approvals' },
          });
        }
        if (round === 2) {
          parentResultRequest = request;
          return chatToolResponse('parent-staggered-nested-end', 'end-agent', {});
        }
        throw new Error(`Unexpected staggered nested parent provider round ${round}.`);
      });
      const createParent = async () =>
        new Agent<OpenAIChatProtocol>({
          llm: createChatModel('offline-staggered-nested-parent', parentCreate),
          subAgentRuntime: await createRuntime(),
          sessionId,
          maxIterations: 3,
        }).init();

      const firstWaiting = await (await createParent()).agent('start nested staggered approvals');
      if (firstWaiting.status !== 'waiting_approval') {
        throw new Error(`expected first nested approval: ${JSON.stringify(firstWaiting)}`);
      }
      expect(firstWaiting.approvals).toHaveLength(1);
      expect(firstWaiting.approvals[0]?.toolName).toBe('nested-first-sensitive-proof');
      expect(parentCreate).toHaveBeenCalledTimes(1);
      expect(coordinatorCreate).toHaveBeenCalledTimes(1);

      releaseSecondLeaf.resolve(undefined);
      await vi.waitFor(async () => {
        const tasks = await stateStore.listTasksByRun(sessionId, firstWaiting.runId);
        const leaves = tasks.filter(
          ({ definition }) => definition.name !== nestedStaggeredCoordinatorDefinition.name,
        );
        expect(leaves.filter(({ state }) => state === 'waiting_approval')).toHaveLength(2);
      });

      const firstApproval = firstWaiting.approvals[0]!;
      const secondWaiting = await (
        await createParent()
      ).resumeRun({
        runId: firstWaiting.runId,
        decisions: [
          {
            approvalId: firstApproval.approvalId,
            decision: 'approved',
            expectedRevision: firstApproval.revision,
          },
        ],
      });
      if (secondWaiting.status !== 'waiting_approval') {
        throw new Error(`expected second nested approval: ${JSON.stringify(secondWaiting)}`);
      }
      expect(secondWaiting.approvals).toHaveLength(1);
      expect(secondWaiting.approvals[0]?.toolName).toBe('nested-second-sensitive-proof');
      expect(parentCreate).toHaveBeenCalledTimes(1);
      expect(coordinatorCreate).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(firstHandler).toHaveBeenCalledOnce());
      expect(firstHandler).toHaveBeenCalledOnce();
      expect(secondHandler).not.toHaveBeenCalled();
      const middleTasks = await stateStore.listTasksByRun(sessionId, firstWaiting.runId);
      expect(
        middleTasks
          .filter(({ definition }) => definition.name !== nestedStaggeredCoordinatorDefinition.name)
          .map(({ state }) => state)
          .sort(),
      ).toEqual(['succeeded', 'waiting_approval']);
      expect(
        middleTasks.find(
          ({ definition }) => definition.name === nestedStaggeredCoordinatorDefinition.name,
        ),
      ).toMatchObject({
        state: 'waiting_approval',
        approvals: [{ approvalId: secondWaiting.approvals[0]!.approvalId }],
      });

      const secondApproval = secondWaiting.approvals[0]!;
      const completed = await (
        await createParent()
      ).resumeRun({
        runId: firstWaiting.runId,
        decisions: [
          {
            approvalId: secondApproval.approvalId,
            decision: 'approved',
            expectedRevision: secondApproval.revision,
          },
        ],
      });
      expect(completed).toMatchObject({
        status: 'succeeded',
        runId: firstWaiting.runId,
        sessionId,
      });
      expect(firstHandler).toHaveBeenCalledOnce();
      expect(secondHandler).toHaveBeenCalledOnce();
      expect(firstLeafCreate).toHaveBeenCalledTimes(3);
      expect(secondLeafCreate).toHaveBeenCalledTimes(3);
      expect(coordinatorCreate).toHaveBeenCalledTimes(3);
      expect(parentCreate).toHaveBeenCalledTimes(2);
      expect(
        extractChatToolOutputs(coordinatorResultRequest).map(
          (entry) => (entry as { readonly callId: string }).callId,
        ),
      ).toEqual(['coordinator-first-leaf', 'coordinator-second-leaf']);
      expect(extractChatToolOutputs(parentResultRequest)).toEqual([
        {
          callId: 'parent-staggered-coordinator',
          output: expect.objectContaining({
            status: 'succeeded',
            output: { answer: 'staggered-coordinator-proof' },
          }),
        },
      ]);
      const terminalTasks = await stateStore.listTasksByRun(sessionId, firstWaiting.runId);
      expect(terminalTasks).toHaveLength(3);
      expect(terminalTasks.every(({ state }) => state === 'succeeded')).toBe(true);
    },
  );

  acceptanceIt('RUN-03.l4.root-approval-resume.local', 'chat-chat-approval-resume', async () => {
    expect(
      Reflect.get(globalThis, Symbol.for('maneeagent.testkit.network-deny-owner.v1')),
    ).toBeDefined();

    const sessionId = 'public-root-approval-resume';
    const executorName = 'local-approval-resume';
    const stateStore = new MemoryAgentRuntimeStateStore();
    const approvedHandler = vi.fn(() => 'approved-tool-proof');
    let childInstances = 0;
    const childCreate = vi
      .fn()
      .mockResolvedValueOnce(
        chatToolResponse('child-sensitive-call', 'sensitive-proof', { marker: 'safe' }),
      )
      .mockResolvedValueOnce(
        chatToolResponse('child-result-call', 'agent-result', {
          result: { answer: 'typed-approved-proof' },
        }),
      )
      .mockResolvedValueOnce(chatToolResponse('child-end-call', 'end-agent', {}));

    const registration = createLocalAgentRunnerRegistration({
      definition: approvalDefinition,
      runnerId: 'approval-proof-runner',
      runnerVersion: '2.0.0',
      createAgent() {
        childInstances += 1;
        const child = new Agent<OpenAIChatProtocol>({
          llm: createChatModel('offline-child-approval', childCreate),
          maxIterations: 4,
        });
        child.tools.push({
          name: 'sensitive-proof',
          description: 'One deterministic approval-gated Tool.',
          parameters: z.object({ marker: z.literal('safe') }).strict(),
          approval: {
            summary: 'Approve the deterministic child proof.',
            expiresInMs: 60_000,
          },
          handler: approvedHandler,
        });
        return child;
      },
      buildInput: ({ input }) => `prove:${input.prompt}`,
    });

    const createRuntime = async () => {
      const runtime = createSubAgentRuntime({
        sessionId,
        activeDefinitions: [approvalDefinition],
        executors: [
          new MemorySubAgentExecutor({
            name: executorName,
            registry: new LocalSubAgentRunnerRegistry([registration]),
          }),
        ],
        stateStore,
      });
      await runtime.init();
      return runtime;
    };

    let parentResultRequest: unknown;
    const parentCreate = vi.fn(async (request: unknown) => {
      const round = parentCreate.mock.calls.length;
      if (round === 1) {
        return chatToolResponse('parent-agent-call', 'agent', {
          subAgent: approvalDefinition.name,
          executor: executorName,
          input: { prompt: 'approval lifecycle' },
        });
      }
      if (round === 2) {
        parentResultRequest = request;
        return chatToolResponse('parent-end-call', 'end-agent', {});
      }
      throw new Error(`Unexpected parent provider round ${round}.`);
    });

    const firstRuntime = await createRuntime();
    const firstParent = new Agent<OpenAIChatProtocol>({
      llm: createChatModel('offline-parent-approval', parentCreate),
      subAgentRuntime: firstRuntime,
      sessionId,
      maxIterations: 3,
    }).init();
    const waiting = await firstParent.agent('start approval lifecycle');

    expect(waiting).toMatchObject({
      status: 'waiting_approval',
      sessionId,
      approvals: [
        {
          callId: 'child-sensitive-call',
          toolName: 'sensitive-proof',
          summary: 'Approve the deterministic child proof.',
        },
      ],
    });
    if (waiting.status !== 'waiting_approval') throw new Error('expected root approval pause');
    expect(approvedHandler).not.toHaveBeenCalled();
    expect(childInstances).toBe(1);
    expect(parentCreate).toHaveBeenCalledTimes(1);
    expect(childCreate).toHaveBeenCalledTimes(1);

    const approval = waiting.approvals[0]!;
    const pausedTask = await stateStore.loadTask(sessionId, approval.taskId);
    expect(pausedTask).toMatchObject({
      taskId: approval.taskId,
      state: 'waiting_approval',
      childCheckpoint: {
        pendingBatch: {
          calls: [
            {
              callId: 'child-sensitive-call',
              status: 'waiting_approval',
              approvals: [approval.approvalId],
            },
          ],
        },
      },
    });
    const pausedRun = await stateStore.loadRun(sessionId, waiting.runId);
    expect(pausedRun).toMatchObject({
      runId: waiting.runId,
      status: 'waiting_approval',
      pendingApprovals: [{ approvalId: approval.approvalId, taskId: approval.taskId }],
      pendingBatch: {
        calls: [
          {
            callId: 'parent-agent-call',
            taskId: approval.taskId,
            status: 'paused',
            approvalIds: [approval.approvalId],
          },
        ],
      },
    });

    const contextBeforeRejectedRun = firstParent.getContext();
    await expect(firstParent.agent('must not create another run')).rejects.toThrow(
      `Agent run ${waiting.runId} is waiting for approval`,
    );
    expect(parentCreate).toHaveBeenCalledTimes(1);
    expect(firstParent.getContext()).toEqual(contextBeforeRejectedRun);
    await expect(stateStore.loadRun(sessionId, waiting.runId)).resolves.toEqual(pausedRun);
    await expect(stateStore.listTasksByRun(sessionId, waiting.runId)).resolves.toHaveLength(1);

    const replacementRuntime = await createRuntime();
    const replacementParent = new Agent<OpenAIChatProtocol>({
      llm: createChatModel('offline-parent-approval', parentCreate),
      subAgentRuntime: replacementRuntime,
      sessionId,
      maxIterations: 3,
    }).init();
    const resumed = await replacementParent.resumeRun({
      runId: waiting.runId,
      decisions: [
        {
          approvalId: approval.approvalId,
          decision: 'approved',
          expectedRevision: approval.revision,
        },
      ],
    });

    expect(resumed).toMatchObject({ status: 'succeeded', sessionId, runId: waiting.runId });
    expect(approvedHandler).toHaveBeenCalledOnce();
    expect(childInstances).toBe(2);
    expect(childCreate).toHaveBeenCalledTimes(3);
    expect(parentCreate).toHaveBeenCalledTimes(2);
    expect(extractChatToolOutputs(parentResultRequest)).toEqual([
      {
        callId: 'parent-agent-call',
        output: expect.objectContaining({
          status: 'succeeded',
          executor: executorName,
          task: {
            taskId: approval.taskId,
            subAgent: { name: approvalDefinition.name, version: approvalDefinition.version },
          },
          output: { answer: 'typed-approved-proof' },
        }),
      },
    ]);
    const terminalTasks = await stateStore.listTasksByRun(sessionId, waiting.runId);
    expect(terminalTasks).toHaveLength(1);
    expect(terminalTasks[0]).toMatchObject({
      taskId: approval.taskId,
      state: 'succeeded',
      result: { status: 'succeeded', output: { answer: 'typed-approved-proof' } },
    });
    const terminalRun = await stateStore.loadRun(sessionId, waiting.runId);
    expect(terminalRun).toMatchObject({
      status: 'succeeded',
      pendingApprovals: [],
    });
    expect(terminalRun).not.toHaveProperty('pendingBatch');
  });

  acceptanceIt('APP-05.l4.nested-agent-resume.local', 'chat-chat-chat', async () => {
    const sessionId = 'public-nested-agent-resume';
    const executorName = 'local-nested-agent-resume';
    const stateStore = new MemoryAgentRuntimeStateStore();
    const leafHandler = vi.fn(() => 'approved-nested-leaf-tool');
    let leafInstances = 0;
    let coordinatorInstances = 0;
    let coordinatorResultRequest: unknown;
    let parentResultRequest: unknown;

    const leafCreate = vi
      .fn()
      .mockResolvedValueOnce(
        chatToolResponse('nested-leaf-sensitive', 'nested-sensitive-proof', {
          marker: 'nested-safe',
        }),
      )
      .mockResolvedValueOnce(
        chatToolResponse('nested-leaf-result', 'agent-result', {
          result: { answer: 'nested-leaf-proof' },
        }),
      )
      .mockResolvedValueOnce(chatToolResponse('nested-leaf-end', 'end-agent', {}));
    const coordinatorCreate = vi.fn(async (request: unknown) => {
      const round = coordinatorCreate.mock.calls.length;
      if (round === 1) {
        return chatToolResponse('coordinator-leaf-call', 'agent', {
          subAgent: nestedLeafDefinition.name,
          executor: executorName,
          input: { prompt: 'nested leaf approval' },
        });
      }
      if (round === 2) {
        coordinatorResultRequest = request;
        return chatToolResponse('coordinator-result', 'agent-result', {
          result: { answer: 'nested-coordinator-proof' },
        });
      }
      if (round === 3) {
        return chatToolResponse('coordinator-end', 'end-agent', {});
      }
      throw new Error(`Unexpected coordinator provider round ${round}.`);
    });
    const parentCreate = vi.fn(async (request: unknown) => {
      const round = parentCreate.mock.calls.length;
      if (round === 1) {
        return chatToolResponse('parent-coordinator-call', 'agent', {
          subAgent: nestedCoordinatorDefinition.name,
          executor: executorName,
          input: { prompt: 'nested coordinator approval' },
        });
      }
      if (round === 2) {
        parentResultRequest = request;
        return chatToolResponse('nested-parent-end', 'end-agent', {});
      }
      throw new Error(`Unexpected nested parent provider round ${round}.`);
    });

    const leafRegistration = createLocalAgentRunnerRegistration({
      definition: nestedLeafDefinition,
      runnerId: 'nested-leaf-runner',
      runnerVersion: '2.0.0',
      createAgent() {
        leafInstances += 1;
        const leaf = new Agent<OpenAIChatProtocol>({
          llm: createChatModel('offline-nested-leaf', leafCreate),
          maxIterations: 4,
        });
        leaf.tools.push({
          name: 'nested-sensitive-proof',
          description: 'One deterministic nested approval-gated Tool.',
          parameters: z.object({ marker: z.literal('nested-safe') }).strict(),
          approval: {
            summary: 'Approve the nested leaf proof.',
            expiresInMs: 60_000,
          },
          handler: leafHandler,
        });
        return leaf;
      },
      buildInput: ({ input }) => `leaf:${input.prompt}`,
    });
    const coordinatorRegistration = createLocalAgentRunnerRegistration({
      definition: nestedCoordinatorDefinition,
      runnerId: 'nested-coordinator-runner',
      runnerVersion: '2.0.0',
      createAgent() {
        coordinatorInstances += 1;
        return new Agent<OpenAIChatProtocol>({
          llm: createChatModel('offline-nested-coordinator', coordinatorCreate),
          maxIterations: 4,
        });
      },
      buildInput: ({ input }) => `coordinator:${input.prompt}`,
    });
    const registry = new LocalSubAgentRunnerRegistry([leafRegistration, coordinatorRegistration]);
    const createRuntime = async () => {
      const runtime = createSubAgentRuntime({
        sessionId,
        activeDefinitions: [nestedCoordinatorDefinition, nestedLeafDefinition],
        executors: [new MemorySubAgentExecutor({ name: executorName, registry })],
        stateStore,
      });
      await runtime.init();
      return runtime;
    };

    const firstParent = new Agent<OpenAIChatProtocol>({
      llm: createChatModel('offline-nested-parent', parentCreate),
      subAgentRuntime: await createRuntime(),
      sessionId,
      maxIterations: 3,
    }).init();
    const waiting = await firstParent.agent('start nested approval lifecycle');
    if (waiting.status !== 'waiting_approval') throw new Error('expected nested approval pause');
    expect(waiting.approvals).toHaveLength(1);
    expect(waiting.approvals[0]).toMatchObject({
      callId: 'nested-leaf-sensitive',
      toolName: 'nested-sensitive-proof',
      summary: 'Approve the nested leaf proof.',
    });
    expect(leafHandler).not.toHaveBeenCalled();
    expect(parentCreate).toHaveBeenCalledTimes(1);
    expect(coordinatorCreate).toHaveBeenCalledTimes(1);
    expect(leafCreate).toHaveBeenCalledTimes(1);

    const pausedTasks = await stateStore.listTasksByRun(sessionId, waiting.runId);
    expect(pausedTasks).toHaveLength(2);
    const coordinatorTask = pausedTasks.find(
      ({ definition }) => definition.name === nestedCoordinatorDefinition.name,
    );
    const leafTask = pausedTasks.find(
      ({ definition }) => definition.name === nestedLeafDefinition.name,
    );
    expect(coordinatorTask).toMatchObject({
      state: 'waiting_approval',
      approvals: [{ taskId: leafTask?.taskId }],
      delegationPause: {
        calls: [
          {
            callId: 'coordinator-leaf-call',
            childTaskId: leafTask?.taskId,
            approvalIds: [waiting.approvals[0]!.approvalId],
          },
        ],
      },
      childCheckpoint: {
        pendingBatch: {
          calls: [
            {
              callId: 'coordinator-leaf-call',
              taskId: leafTask?.taskId,
              status: 'waiting_approval',
            },
          ],
        },
      },
    });
    expect(leafTask).toMatchObject({
      state: 'waiting_approval',
      parentTaskId: coordinatorTask?.taskId,
    });

    const approval = waiting.approvals[0]!;
    const replacementParent = new Agent<OpenAIChatProtocol>({
      llm: createChatModel('offline-nested-parent', parentCreate),
      subAgentRuntime: await createRuntime(),
      sessionId,
      maxIterations: 3,
    }).init();
    const resumed = await replacementParent.resumeRun({
      runId: waiting.runId,
      decisions: [
        {
          approvalId: approval.approvalId,
          decision: 'approved',
          expectedRevision: approval.revision,
        },
      ],
    });

    expect(resumed).toMatchObject({ status: 'succeeded', runId: waiting.runId, sessionId });
    expect(leafHandler).toHaveBeenCalledOnce();
    expect(leafInstances).toBe(2);
    expect(coordinatorInstances).toBe(2);
    expect(leafCreate).toHaveBeenCalledTimes(3);
    expect(coordinatorCreate).toHaveBeenCalledTimes(3);
    expect(parentCreate).toHaveBeenCalledTimes(2);
    expect(extractChatToolOutputs(coordinatorResultRequest)).toEqual([
      {
        callId: 'coordinator-leaf-call',
        output: expect.objectContaining({
          status: 'succeeded',
          task: expect.objectContaining({ taskId: leafTask?.taskId }),
          output: { answer: 'nested-leaf-proof' },
        }),
      },
    ]);
    expect(extractChatToolOutputs(parentResultRequest)).toEqual([
      {
        callId: 'parent-coordinator-call',
        output: expect.objectContaining({
          status: 'succeeded',
          task: expect.objectContaining({ taskId: coordinatorTask?.taskId }),
          output: { answer: 'nested-coordinator-proof' },
        }),
      },
    ]);
    const terminalTasks = await stateStore.listTasksByRun(sessionId, waiting.runId);
    expect(terminalTasks.map(({ taskId }) => taskId).sort()).toEqual(
      [coordinatorTask?.taskId, leafTask?.taskId].sort(),
    );
    expect(terminalTasks.every(({ state }) => state === 'succeeded')).toBe(true);
  });
});

function createChatModel(model: string, create: ReturnType<typeof vi.fn>): OpenAIChatModel {
  return new OpenAIChatModel({
    model,
    client: { chat: { completions: { create } } } as never,
  });
}

function chatToolResponse(callId: string, name: string, parameters: JsonValue) {
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: callId,
              type: 'function',
              function: { name, arguments: JSON.stringify(parameters) },
            },
          ],
        },
      },
    ],
  };
}

function chatToolCallsResponse(
  calls: readonly {
    readonly callId: string;
    readonly name: string;
    readonly parameters: JsonValue;
  }[],
) {
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: calls.map(({ callId, name, parameters }) => ({
            id: callId,
            type: 'function',
            function: { name, arguments: JSON.stringify(parameters) },
          })),
        },
      },
    ],
  };
}

function extractChatToolOutputs(request: unknown): readonly unknown[] {
  if (typeof request !== 'object' || request === null || !('messages' in request)) return [];
  const messages = (request as { readonly messages?: readonly unknown[] }).messages ?? [];
  return messages.flatMap((message) => {
    if (typeof message !== 'object' || message === null) return [];
    const record = message as {
      readonly role?: unknown;
      readonly tool_call_id?: unknown;
      readonly content?: unknown;
    };
    if (
      record.role !== 'tool' ||
      typeof record.tool_call_id !== 'string' ||
      typeof record.content !== 'string'
    ) {
      return [];
    }
    return [
      {
        callId: record.tool_call_id,
        output: JSON.parse(record.content) as JsonValue,
      },
    ];
  });
}
