export type DeterministicIdKind = 'session' | 'run' | 'task' | 'approval' | 'event';

export interface DeterministicIdFactoryOptions {
  readonly prefix?: string;
  readonly initialCounter?: number;
  readonly width?: number;
}

const PORTABLE_SEGMENT = /^[a-z][a-z0-9-]*$/u;

function assertPortableSegment(value: string, label: string): void {
  if (!PORTABLE_SEGMENT.test(value)) {
    throw new TypeError(`${label} must be a portable lowercase identifier segment.`);
  }
}

/** Generates independent, reproducible ID sequences for every logical ID kind. */
export class DeterministicIdFactory {
  readonly #prefix: string;
  readonly #initialCounter: number;
  readonly #width: number;
  readonly #counters = new Map<string, number>();

  constructor(options: DeterministicIdFactoryOptions = {}) {
    const prefix = options.prefix ?? 'test';
    const initialCounter = options.initialCounter ?? 1;
    const width = options.width ?? 4;

    assertPortableSegment(prefix, 'prefix');
    if (!Number.isSafeInteger(initialCounter) || initialCounter < 0) {
      throw new RangeError('initialCounter must be a non-negative safe integer.');
    }
    if (!Number.isSafeInteger(width) || width < 1 || width > 16) {
      throw new RangeError('width must be an integer between 1 and 16.');
    }

    this.#prefix = prefix;
    this.#initialCounter = initialCounter;
    this.#width = width;
  }

  next(kind: DeterministicIdKind | (string & {})): string {
    assertPortableSegment(kind, 'kind');
    const counter = this.#counters.get(kind) ?? this.#initialCounter;
    if (!Number.isSafeInteger(counter + 1)) {
      throw new RangeError(`The deterministic ${kind} ID sequence is exhausted.`);
    }

    this.#counters.set(kind, counter + 1);
    return `${this.#prefix}-${kind}-${String(counter).padStart(this.#width, '0')}`;
  }

  nextSessionId(): string {
    return this.next('session');
  }

  nextRunId(): string {
    return this.next('run');
  }

  nextTaskId(): string {
    return this.next('task');
  }

  nextApprovalId(): string {
    return this.next('approval');
  }

  nextEventId(): string {
    return this.next('event');
  }

  count(kind: DeterministicIdKind | (string & {})): number {
    assertPortableSegment(kind, 'kind');
    return (this.#counters.get(kind) ?? this.#initialCounter) - this.#initialCounter;
  }

  snapshot(): Readonly<Record<string, number>> {
    return Object.freeze(
      Object.fromEntries([...this.#counters].sort(([left], [right]) => left.localeCompare(right))),
    );
  }
}
