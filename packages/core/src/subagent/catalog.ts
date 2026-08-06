import type { z } from 'zod';

import type { ExecutorCapabilityRequirement } from './definition';
import type { SubAgentDefinitionRef } from './identity';
import type { JsonValue } from './json';

export interface SubAgentExecutorDescriptor {
  /** Exact Core/Executor control-plane wire version understood by this adapter. */
  readonly runtimeProtocolVersion: '1';
  /** Persisted Core task record versions that this adapter can safely execute or recover. */
  readonly taskRecordVersions: readonly string[];
  /** Child checkpoint versions accepted by this adapter. */
  readonly childCheckpointVersions: readonly string[];
  /** Exact runner/checkpoint identities available from the adapter's trusted registry. */
  readonly runnerCompatibility: readonly {
    readonly runnerId: string;
    readonly runnerVersion: string;
    readonly childCheckpointVersions: readonly string[];
  }[];
  readonly name: string;
  readonly description: string;
  readonly useCases: readonly string[];
  readonly capabilities: {
    readonly execute: true;
    readonly spawn: boolean;
    readonly cancel: boolean;
    readonly events: boolean;
    readonly approval: boolean;
    readonly usage: 'none' | 'estimated' | 'provider';
    readonly recovery: {
      readonly resume: 'none' | 'same_process' | 'checkpoint';
      readonly reconnect: 'none' | 'external_binding';
    };
  };
  readonly adapterStateVersion: string;
  /** Maximum canonical JSON size accepted for the complete persisted binding. */
  readonly maxBindingBytes: number;
  /** Maximum events returned by one adapter event page. */
  readonly maxEventPageSize: number;
}

export interface ExecutorAvailabilityProbe {
  readonly status: 'available' | 'degraded' | 'unavailable';
  readonly reasonCode?: string;
  readonly supportedDefinitions?: readonly SubAgentDefinitionRef[];
}

export interface ExecutorAvailability extends ExecutorAvailabilityProbe {
  readonly descriptor: SubAgentExecutorDescriptor;
}

export interface ExecutorCatalogSnapshot {
  readonly revision: number;
  readonly capturedAt: number;
  readonly executors: readonly ExecutorAvailability[];
}

export interface ExecutorCatalogPolicy {
  /** Degraded Executors remain eligible by default, but hosts may opt out explicitly. */
  readonly allowDegraded?: boolean;
  /** Optional additional host capability floor applied before definition-specific policy. */
  readonly requiredCapabilities?: ExecutorCapabilityRequirement;
}

/** Model-safe Executor metadata retained after conservative catalog filtering. */
export interface SubAgentCatalogExecutorEntry extends SubAgentExecutorDescriptor {
  readonly status: 'available' | 'degraded';
  readonly reasonCode?: string;
}

/** Host catalog entry after availability, support, allowlist and capability intersection. */
export interface SubAgentCatalogEntry<I extends JsonValue = JsonValue> {
  readonly definition: SubAgentDefinitionRef;
  readonly description: string;
  readonly inputSchema: z.ZodType<I>;
  readonly executors: readonly SubAgentCatalogExecutorEntry[];
}
