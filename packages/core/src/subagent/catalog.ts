import type { z } from 'zod';

import type { ExecutorCapabilityRequirement } from './definition';
import type { SubAgentDefinitionRef } from './identity';
import type { JsonValue } from './json';

export interface SubAgentExecutorDescriptor {
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

/** Host catalog entry after availability, support, allowlist and capability intersection. */
export interface SubAgentCatalogEntry<I extends JsonValue = JsonValue> {
  readonly definition: SubAgentDefinitionRef;
  readonly description: string;
  readonly inputSchema: z.ZodType<I>;
  readonly executors: readonly SubAgentExecutorDescriptor[];
}
