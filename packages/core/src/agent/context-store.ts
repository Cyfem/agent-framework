import type { AgentProtocol, ContextOf } from './types';

/** ContextStore tracks messages in atomic provenance spans. */
export type ContextEntryKind = 'seed' | 'user' | 'external' | 'loop' | 'summary' | 'preserved';

/** Sidecar metadata for one message in the active model context. */
export interface ActiveContextEntry<P extends AgentProtocol> {
  readonly entryId: string;
  readonly spanId: string;
  readonly kind: ContextEntryKind;
  readonly active: ContextOf<P>;
  readonly rawHistoryIndex?: number;
  readonly original?: ContextOf<P>;
}

/** A logical group whose original and active projections may differ. */
export interface ContextSpan<P extends AgentProtocol> {
  readonly spanId: string;
  readonly kind: ContextEntryKind;
  readonly closed: boolean;
  readonly originalContext: readonly ContextOf<P>[];
  readonly entries: readonly ActiveContextEntry<P>[];
}

/** CAS token and active projection for the currently open loop span. */
export interface OpenLoopSnapshot<P extends AgentProtocol> {
  readonly spanId: string;
  readonly revision: number;
  readonly activeContext: readonly ContextOf<P>[];
}

/** The summary value currently installed at the head of active context. */
export interface ContextStoreSummaryValue<P extends AgentProtocol> {
  readonly text: string;
  readonly message: ContextOf<P>;
}

/** Store-owned part of a public summary snapshot. */
export interface ContextStoreSummarySnapshot<P extends AgentProtocol> {
  readonly revision: number;
  readonly activeContext: readonly ContextOf<P>[];
  readonly boundaryOriginalContext: readonly ContextOf<P>[];
  readonly boundaryActiveContext: readonly ContextOf<P>[];
  readonly rawHistory: readonly ContextOf<P>[];
  readonly previousSummary?: ContextStoreSummaryValue<P>;
}

/** Candidate selected by the framework's span-aware default summary policy. */
export interface ContextStoreSummarySelection<P extends AgentProtocol> {
  readonly contextToSummarize: readonly ContextOf<P>[];
  readonly preservedContext: readonly ContextOf<P>[];
}

/** Atomic summary replacement to apply against an exact store revision. */
export interface ContextStoreSummaryTransaction<P extends AgentProtocol> {
  readonly revision: number;
  readonly summaryText: string;
  readonly summaryMessage: ContextOf<P>;
  readonly preservedContext: readonly ContextOf<P>[];
}

export type ContextStoreErrorCode =
  | 'concurrent_context_mutation'
  | 'invalid_open_loop_snapshot'
  | 'invalid_open_loop_rewrite'
  | 'open_loop_already_exists'
  | 'open_loop_not_found'
  | 'summary_during_open_loop'
  | 'context_store_invariant';

/** Stable, machine-readable error raised when a ContextStore invariant fails. */
export class ContextStoreError extends Error {
  readonly code: ContextStoreErrorCode;

  constructor(code: ContextStoreErrorCode, message: string = code) {
    super(message);
    this.name = 'ContextStoreError';
    this.code = code;
  }
}

interface MutableActiveContextEntry<P extends AgentProtocol> {
  entryId: string;
  spanId: string;
  kind: ContextEntryKind;
  active: ContextOf<P>;
  rawHistoryIndex?: number;
  original?: ContextOf<P>;
}

interface MutableContextSpan<P extends AgentProtocol> {
  spanId: string;
  kind: ContextEntryKind;
  closed: boolean;
  originalContext: ContextOf<P>[];
  entries: MutableActiveContextEntry<P>[];
}

interface PreviousSummary {
  entryId: string;
  text: string;
}

/**
 * Owns the append-only raw history and the copy-on-write context sent to a Model.
 *
 * The store intentionally keeps provider messages opaque. Object identity is only
 * used to recover provenance for a custom `preservedContext` selection.
 */
export class ContextStore<P extends AgentProtocol> {
  #rawHistory: ContextOf<P>[];
  #activeSpans: MutableContextSpan<P>[] = [];
  #summaryBoundarySpanId: string | undefined;
  #previousSummary: PreviousSummary | undefined;
  #openLoopSpanId: string | undefined;
  #revision = 0;
  #nextSpanId = 1;
  #nextEntryId = 1;

  constructor(initContext?: readonly ContextOf<P>[], initRawContext?: readonly ContextOf<P>[]) {
    const active = [...(initContext ?? initRawContext ?? [])];
    const raw = [...(initRawContext ?? initContext ?? [])];

    this.#rawHistory = raw;

    // When both arrays are supplied they form an opaque, possibly non-aligned
    // seed. A missing side explicitly means the other projection is shared and
    // therefore has safe item-level provenance.
    const hasItemProvenance = initContext === undefined || initRawContext === undefined;
    const span = this.#newSpan('seed', true, raw);

    span.entries = active.map((message, index) =>
      this.#newEntry(
        span,
        message,
        hasItemProvenance && index < raw.length ? index : undefined,
        hasItemProvenance && index < raw.length ? raw[index] : undefined,
      ),
    );
    this.#activeSpans.push(span);
  }

  /** Monotonic version used by tool and summary transactions. */
  get revision(): number {
    return this.#revision;
  }

  /** Whether messages are currently being accumulated into one loop span. */
  get hasOpenLoopSpan(): boolean {
    return this.#openLoopSpanId !== undefined;
  }

  /** Return a shallow copy of the context currently sent to the Model. */
  getActiveContext(): readonly ContextOf<P>[] {
    return this.#activeSpans.flatMap((span) => span.entries.map((entry) => entry.active));
  }

  /** Return a shallow copy of the complete, append-only history. */
  getRawHistory(): readonly ContextOf<P>[] {
    return [...this.#rawHistory];
  }

  /**
   * Append a closed one-message span to raw and active context.
   * Standalone writes while a loop is open are rejected so callers cannot
   * accidentally place a loop listener message outside its atomic span.
   */
  appendStandalone(
    message: ContextOf<P>,
    kind: Extract<ContextEntryKind, 'user' | 'external'> = 'external',
  ): void {
    if (this.#openLoopSpanId !== undefined) {
      throw new ContextStoreError(
        'open_loop_already_exists',
        'Cannot append a standalone span while a loop span is open.',
      );
    }

    const rawHistoryIndex = this.#rawHistory.push(message) - 1;
    const span = this.#newSpan(kind, true, [message]);
    span.entries.push(this.#newEntry(span, message, rawHistoryIndex, message));
    this.#activeSpans.push(span);
    this.#bumpRevision();
  }

  /** Open an empty span for one model response and all of its tool-side effects. */
  openLoopSpan(): string {
    if (this.#openLoopSpanId !== undefined) {
      throw new ContextStoreError('open_loop_already_exists', 'A loop span is already open.');
    }

    const span = this.#newSpan('loop', false, []);
    this.#activeSpans.push(span);
    this.#openLoopSpanId = span.spanId;
    this.#bumpRevision();
    return span.spanId;
  }

  /** Append one raw message and active entry to the current loop span. */
  appendToOpenLoop(message: ContextOf<P>): void {
    const span = this.#requireOpenLoopSpan();
    const rawHistoryIndex = this.#rawHistory.push(message) - 1;

    span.originalContext.push(message);
    span.entries.push(this.#newEntry(span, message, rawHistoryIndex, message));
    this.#bumpRevision();
  }

  /** Synchronously close the current loop without rewriting its active entries. */
  closeOpenLoopSpan(): void {
    const span = this.#requireOpenLoopSpan();
    span.closed = true;
    this.#openLoopSpanId = undefined;
    this.#bumpRevision();
  }

  /** Capture an exact-revision snapshot of the current loop projection. */
  snapshotOpenLoop(): OpenLoopSnapshot<P> {
    const span = this.#requireOpenLoopSpan();

    return {
      spanId: span.spanId,
      revision: this.#revision,
      activeContext: span.entries.map((entry) => entry.active),
    };
  }

  /**
   * Atomically replace only the open loop projection and close the span.
   * Raw history and per-entry original provenance remain untouched.
   */
  commitOpenLoopRewrite(snapshot: OpenLoopSnapshot<P>, messages: readonly ContextOf<P>[]): void {
    const span = this.#requireOpenLoopSpan();

    if (span.spanId !== snapshot.spanId) {
      throw new ContextStoreError(
        'invalid_open_loop_snapshot',
        'The open loop span does not match the captured snapshot.',
      );
    }

    if (this.#revision !== snapshot.revision) {
      throw new ContextStoreError(
        'concurrent_context_mutation',
        'Context changed after the loop snapshot was captured.',
      );
    }

    if (messages.length !== span.entries.length) {
      throw new ContextStoreError(
        'invalid_open_loop_rewrite',
        'A loop rewrite must preserve the number and order of context entries.',
      );
    }

    span.entries = span.entries.map((entry, index) => ({
      ...entry,
      active: messages[index] as ContextOf<P>,
    }));
    span.closed = true;
    this.#openLoopSpanId = undefined;
    this.#bumpRevision();
  }

  /**
   * Close an open loop after a failed transaction, retaining every raw and
   * uncommitted active message. It is deliberately a no-op when no loop exists.
   */
  abortOpenLoopSpan(): void {
    if (this.#openLoopSpanId === undefined) {
      return;
    }

    const span = this.#findSpan(this.#openLoopSpanId);

    if (!span || span.closed) {
      throw new ContextStoreError(
        'context_store_invariant',
        'The open loop pointer does not reference an open span.',
      );
    }

    span.closed = true;
    this.#openLoopSpanId = undefined;
    this.#bumpRevision();
  }

  /** Build raw, active, boundary, and rolling-summary projections atomically. */
  getSummarySnapshot(): ContextStoreSummarySnapshot<P> {
    const boundarySpans = this.#getBoundarySpans();
    const previousSummary = this.#resolvePreviousSummary();

    return {
      revision: this.#revision,
      activeContext: this.getActiveContext(),
      boundaryOriginalContext: boundarySpans.flatMap((span) => [...span.originalContext]),
      boundaryActiveContext: boundarySpans.flatMap((span) =>
        span.entries.map((entry) => entry.active),
      ),
      rawHistory: this.getRawHistory(),
      ...(previousSummary ? { previousSummary } : {}),
    };
  }

  /**
   * Select the framework default without leaking span metadata to public hooks.
   * Trigger compaction preserves the latest full non-empty span; emergency
   * compaction summarizes the complete boundary.
   */
  getDefaultSummarySelection(
    cause: 'trigger' | 'context_length_exceeded',
  ): ContextStoreSummarySelection<P> | undefined {
    const boundarySpans = this.#getBoundarySpans();

    if (cause === 'context_length_exceeded') {
      const contextToSummarize = boundarySpans.flatMap((span) => [...span.originalContext]);

      return contextToSummarize.length === 0
        ? undefined
        : { contextToSummarize, preservedContext: [] };
    }

    let preservedSpanIndex = -1;

    for (let index = boundarySpans.length - 1; index >= 0; index -= 1) {
      const span = boundarySpans[index];

      if (span?.closed && span.entries.length > 0) {
        preservedSpanIndex = index;
        break;
      }
    }

    if (preservedSpanIndex <= 0) {
      return undefined;
    }

    const contextToSummarize = boundarySpans
      .slice(0, preservedSpanIndex)
      .flatMap((span) => [...span.originalContext]);

    if (contextToSummarize.length === 0) {
      return undefined;
    }

    return {
      contextToSummarize,
      preservedContext: boundarySpans[preservedSpanIndex]!.entries.map((entry) => entry.active),
    };
  }

  /**
   * Atomically install a synthetic summary followed by arbitrary preserved
   * messages. This never appends either projection to raw history.
   */
  commitSummary(transaction: ContextStoreSummaryTransaction<P>): void {
    if (this.#revision !== transaction.revision) {
      throw new ContextStoreError(
        'concurrent_context_mutation',
        'Context changed after the summary snapshot was captured.',
      );
    }

    if (this.#openLoopSpanId !== undefined) {
      throw new ContextStoreError(
        'summary_during_open_loop',
        'A summary cannot be committed while a loop span is open.',
      );
    }

    const sourceSpans = this.#activeSpans;
    const summarySpan = this.#newSpan('summary', true, []);
    const summaryEntry = this.#newEntry(summarySpan, transaction.summaryMessage);
    summarySpan.entries.push(summaryEntry);

    const preservedSpans = this.#buildPreservedSpans(transaction.preservedContext, sourceSpans);

    this.#activeSpans = [summarySpan, ...preservedSpans];
    this.#summaryBoundarySpanId = summarySpan.spanId;
    this.#previousSummary = {
      entryId: summaryEntry.entryId,
      text: transaction.summaryText,
    };
    this.#bumpRevision();
  }

  #buildPreservedSpans(
    preservedContext: readonly ContextOf<P>[],
    sourceSpans: readonly MutableContextSpan<P>[],
  ): MutableContextSpan<P>[] {
    if (preservedContext.length === 0) {
      return [];
    }

    const selectionCounts = countByIdentity(preservedContext);
    const sourceEntries = sourceSpans.flatMap((span) => span.entries);
    const usedEntryIds = new Set<string>();
    const result: MutableContextSpan<P>[] = [];
    let index = 0;

    while (index < preservedContext.length) {
      const fullSpanMatch = this.#findUniqueFullSpanMatch(
        preservedContext,
        index,
        selectionCounts,
        sourceSpans,
      );

      if (fullSpanMatch) {
        const preservedSpan = this.#newSpan('preserved', true, fullSpanMatch.originalContext);

        preservedSpan.entries = fullSpanMatch.entries.map((entry) => {
          usedEntryIds.add(entry.entryId);
          return this.#newEntry(preservedSpan, entry.active, entry.rawHistoryIndex, entry.original);
        });
        result.push(preservedSpan);
        index += fullSpanMatch.entries.length;
        continue;
      }

      const selected = preservedContext[index] as ContextOf<P>;
      const sourceEntry = sourceEntries.find(
        (entry) => !usedEntryIds.has(entry.entryId) && entry.active === selected,
      );
      const original = sourceEntry ? this.#resolveEntryOriginal(sourceEntry) : selected;
      const preservedSpan = this.#newSpan('preserved', true, [original]);

      if (sourceEntry) {
        usedEntryIds.add(sourceEntry.entryId);
      }

      preservedSpan.entries.push(
        this.#newEntry(preservedSpan, selected, sourceEntry?.rawHistoryIndex, original),
      );
      result.push(preservedSpan);
      index += 1;
    }

    return result;
  }

  #findUniqueFullSpanMatch(
    preservedContext: readonly ContextOf<P>[],
    startIndex: number,
    selectionCounts: ReadonlyMap<ContextOf<P>, number>,
    sourceSpans: readonly MutableContextSpan<P>[],
  ): MutableContextSpan<P> | undefined {
    const matches = sourceSpans.filter((span) => {
      if (span.entries.length === 0 || startIndex + span.entries.length > preservedContext.length) {
        return false;
      }

      return span.entries.every((entry, offset) => {
        const selected = preservedContext[startIndex + offset];
        return selected === entry.active && selectionCounts.get(selected as ContextOf<P>) === 1;
      });
    });

    return matches.length === 1 ? matches[0] : undefined;
  }

  #resolveEntryOriginal(entry: MutableActiveContextEntry<P>): ContextOf<P> {
    if (entry.original !== undefined) {
      return entry.original;
    }

    if (entry.rawHistoryIndex !== undefined && entry.rawHistoryIndex in this.#rawHistory) {
      return this.#rawHistory[entry.rawHistoryIndex] as ContextOf<P>;
    }

    return entry.active;
  }

  #getBoundarySpans(): readonly MutableContextSpan<P>[] {
    if (this.#summaryBoundarySpanId === undefined) {
      return this.#activeSpans;
    }

    const boundaryIndex = this.#activeSpans.findIndex(
      (span) => span.spanId === this.#summaryBoundarySpanId,
    );

    if (boundaryIndex < 0) {
      throw new ContextStoreError(
        'context_store_invariant',
        'The summary boundary span is missing from active context.',
      );
    }

    return this.#activeSpans.slice(boundaryIndex + 1);
  }

  #resolvePreviousSummary(): ContextStoreSummaryValue<P> | undefined {
    if (!this.#previousSummary) {
      return undefined;
    }

    const entry = this.#activeSpans
      .flatMap((span) => span.entries)
      .find((candidate) => candidate.entryId === this.#previousSummary?.entryId);

    if (!entry) {
      throw new ContextStoreError(
        'context_store_invariant',
        'The previous summary entry is missing from active context.',
      );
    }

    return {
      text: this.#previousSummary.text,
      message: entry.active,
    };
  }

  #newSpan(
    kind: ContextEntryKind,
    closed: boolean,
    originalContext: readonly ContextOf<P>[],
  ): MutableContextSpan<P> {
    return {
      spanId: `context-span-${this.#nextSpanId++}`,
      kind,
      closed,
      originalContext: [...originalContext],
      entries: [],
    };
  }

  #newEntry(
    span: MutableContextSpan<P>,
    active: ContextOf<P>,
    rawHistoryIndex?: number,
    original?: ContextOf<P>,
  ): MutableActiveContextEntry<P> {
    return {
      entryId: `context-entry-${this.#nextEntryId++}`,
      spanId: span.spanId,
      kind: span.kind,
      active,
      ...(rawHistoryIndex === undefined ? {} : { rawHistoryIndex }),
      ...(original === undefined ? {} : { original }),
    };
  }

  #requireOpenLoopSpan(): MutableContextSpan<P> {
    if (this.#openLoopSpanId === undefined) {
      throw new ContextStoreError('open_loop_not_found', 'There is no open loop span.');
    }

    const span = this.#findSpan(this.#openLoopSpanId);

    if (!span || span.closed) {
      throw new ContextStoreError(
        'context_store_invariant',
        'The open loop pointer does not reference an open span.',
      );
    }

    return span;
  }

  #findSpan(spanId: string): MutableContextSpan<P> | undefined {
    return this.#activeSpans.find((span) => span.spanId === spanId);
  }

  #bumpRevision(): void {
    this.#revision += 1;
  }
}

function countByIdentity<T>(values: readonly T[]): ReadonlyMap<T, number> {
  const counts = new Map<T, number>();

  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  return counts;
}
