export const ACCEPTANCE_EVIDENCE_SCHEMA = 'subagent-v2-acceptance-case/v1' as const;

export type AcceptanceCaseStatus = 'passed' | 'failed' | 'skipped';

export interface AcceptanceCaseEvidence {
  readonly schema: typeof ACCEPTANCE_EVIDENCE_SCHEMA;
  readonly sequence: number;
  readonly caseId: string;
  readonly variant: string;
  readonly status: AcceptanceCaseStatus;
  readonly durationMs: number;
  readonly failureCode?: string;
  readonly skipReasonCode?: string;
}

export interface AcceptanceCaseHandle {
  readonly sequence: number;
  readonly caseId: string;
  readonly variant: string;
  readonly startedAt: number;
}

export type AcceptanceEvidenceSink = (jsonLine: string) => void;

const LABEL = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

function assertLabel(value: string, label: string): void {
  if (!LABEL.test(value)) {
    throw new TypeError(`${label} must be a non-empty portable identifier.`);
  }
}

function failureCode(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    try {
      const code = Reflect.get(error, 'code');
      if (typeof code === 'string' && /^[A-Z][A-Z0-9_]*$/u.test(code)) {
        return code;
      }
    } catch {
      // Hostile error objects must not break evidence collection.
    }
  }
  return 'UNCLASSIFIED_TEST_FAILURE';
}

/** Minimal in-memory reporter with an optional safe JSONL sink. */
export class AcceptanceReporter {
  readonly #clock: () => number;
  readonly #sink: AcceptanceEvidenceSink | undefined;
  readonly #active = new Map<AcceptanceCaseHandle, true>();
  readonly #caseIds = new Set<string>();
  readonly #evidence: AcceptanceCaseEvidence[] = [];
  #sequence = 0;

  constructor(
    options: { readonly clock?: () => number; readonly sink?: AcceptanceEvidenceSink } = {},
  ) {
    this.#clock = options.clock ?? Date.now;
    this.#sink = options.sink;
  }

  startCase(caseId: string, variant: string): AcceptanceCaseHandle {
    assertLabel(caseId, 'caseId');
    assertLabel(variant, 'variant');
    if (this.#caseIds.has(caseId)) {
      throw new Error(`Acceptance caseId "${caseId}" is already registered.`);
    }

    this.#caseIds.add(caseId);
    const handle = Object.freeze({
      sequence: this.#sequence++,
      caseId,
      variant,
      startedAt: this.#clock(),
    });
    this.#active.set(handle, true);
    return handle;
  }

  passCase(handle: AcceptanceCaseHandle): AcceptanceCaseEvidence {
    return this.#finish(handle, 'passed');
  }

  failCase(handle: AcceptanceCaseHandle, error: unknown): AcceptanceCaseEvidence {
    return this.#finish(handle, 'failed', failureCode(error));
  }

  skipCase(caseId: string, variant: string, reasonCode: string): AcceptanceCaseEvidence {
    assertLabel(reasonCode, 'reasonCode');
    const handle = this.startCase(caseId, variant);
    return this.#finish(handle, 'skipped', undefined, reasonCode);
  }

  snapshot(): readonly AcceptanceCaseEvidence[] {
    return Object.freeze([...this.#evidence].sort((left, right) => left.sequence - right.sequence));
  }

  #finish(
    handle: AcceptanceCaseHandle,
    status: AcceptanceCaseStatus,
    failure: string | undefined = undefined,
    skipReason: string | undefined = undefined,
  ): AcceptanceCaseEvidence {
    if (!this.#active.delete(handle)) {
      throw new Error('Acceptance case handle is unknown or already settled.');
    }

    const evidence = Object.freeze({
      schema: ACCEPTANCE_EVIDENCE_SCHEMA,
      sequence: handle.sequence,
      caseId: handle.caseId,
      variant: handle.variant,
      status,
      durationMs: Math.max(0, this.#clock() - handle.startedAt),
      ...(failure ? { failureCode: failure } : {}),
      ...(skipReason ? { skipReasonCode: skipReason } : {}),
    });
    this.#evidence.push(evidence);
    this.#sink?.(`${JSON.stringify(evidence)}\n`);
    return evidence;
  }
}

let defaultReporter = new AcceptanceReporter();

export function getAcceptanceReporter(): AcceptanceReporter {
  return defaultReporter;
}

export function setAcceptanceReporter(reporter: AcceptanceReporter): void {
  defaultReporter = reporter;
}
