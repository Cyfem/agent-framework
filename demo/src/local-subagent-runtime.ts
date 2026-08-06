import {
  createSubAgentRuntime,
  type AgentProtocol,
  type JsonValue,
  type SubAgentDefinition,
  type SubAgentRuntime,
} from '@manee/agent-framework';
import {
  createLocalAgentRunnerRegistration,
  LocalSubAgentRunnerRegistry,
  MemoryAgentRuntimeStateStore,
  MemorySubAgentExecutor,
  type LocalSubAgentAgentRegistration,
} from '@manee/agent-executor-local';

export interface DemoLocalSubAgentRuntime {
  readonly runtime: SubAgentRuntime;
  readonly stateStore: MemoryAgentRuntimeStateStore;
  readonly executor: MemorySubAgentExecutor;
}

/** Build one ready, session-bound v2 runtime from a trusted local Agent factory. */
export async function createDemoLocalSubAgentRuntime<
  P extends AgentProtocol,
  I extends JsonValue,
  O extends JsonValue,
>(options: {
  readonly sessionId: string;
  readonly executorName?: string;
  readonly definition: SubAgentDefinition<I, O>;
  readonly registration: Omit<LocalSubAgentAgentRegistration<P, I, O>, 'definition'>;
}): Promise<DemoLocalSubAgentRuntime> {
  const stateStore = new MemoryAgentRuntimeStateStore();
  const registry = new LocalSubAgentRunnerRegistry([
    createLocalAgentRunnerRegistration({
      ...options.registration,
      definition: options.definition,
    }),
  ]);
  const executor = new MemorySubAgentExecutor({
    registry,
    name: options.executorName ?? 'local',
  });
  const runtime = createSubAgentRuntime({
    sessionId: options.sessionId,
    activeDefinitions: [options.definition],
    executors: [executor],
    stateStore,
  });

  await runtime.init();
  return Object.freeze({ runtime, stateStore, executor });
}
