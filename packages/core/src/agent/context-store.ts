import type { AgentProtocol, ContextOf } from './types';
import type {
  AgentProtocolCheckpointCodec,
  ContextStoreCheckpointV1,
} from '../subagent/checkpoint';
import {
  assertJsonValue,
  canonicalizeJson,
  parseJsonValue,
  type JsonValue,
} from '../subagent/json';

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
  | 'context_checkpoint_codec_mismatch'
  | 'context_checkpoint_version_mismatch'
  | 'invalid_context_checkpoint'
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
  rawItemId?: string;
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
  #rawItemIds: string[];
  #activeSpans: MutableContextSpan<P>[] = [];
  #summaryBoundarySpanId: string | undefined;
  #previousSummary: PreviousSummary | undefined;
  #openLoopSpanId: string | undefined;
  #revision = 0;
  #nextRawItemId = 1;
  #nextSpanId = 1;
  #nextEntryId = 1;

  constructor(initContext?: readonly ContextOf<P>[], initRawContext?: readonly ContextOf<P>[]) {
    const active = [...(initContext ?? initRawContext ?? [])];
    const raw = [...(initRawContext ?? initContext ?? [])];

    this.#rawHistory = raw;
    this.#rawItemIds = raw.map(() => this.#newRawItemId());

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
   * Export the complete ContextStore state using one exact protocol codec.
   * Every protocol value is copied through the codec and every provenance edge
   * is persisted by stable ID rather than by JavaScript object identity.
   */
  exportCheckpoint(codec: AgentProtocolCheckpointCodec<P>): ContextStoreCheckpointV1 {
    assertCheckpointCodec(codec);

    const encode = (message: ContextOf<P>): JsonValue =>
      cloneJsonValue(codec.encode([message]), 'Protocol checkpoint codec output');

    return {
      version: '1',
      protocol: codec.protocol,
      codecVersion: codec.version,
      revision: this.#revision,
      rawHistory: this.#rawHistory.map((message, index) => ({
        itemId: this.#rawItemIds[index] as string,
        value: encode(message),
      })),
      activeSpans: this.#activeSpans.map((span) => ({
        spanId: span.spanId,
        kind: span.kind,
        closed: span.closed,
        originalContext: span.originalContext.map(encode),
        entries: span.entries.map((entry) => ({
          entryId: entry.entryId,
          spanId: entry.spanId,
          kind: entry.kind,
          active: encode(entry.active),
          ...(entry.rawItemId === undefined ? {} : { rawItemId: entry.rawItemId }),
          ...(entry.original === undefined ? {} : { original: encode(entry.original) }),
        })),
      })),
      ...(this.#summaryBoundarySpanId === undefined
        ? {}
        : { summaryBoundarySpanId: this.#summaryBoundarySpanId }),
      ...(this.#previousSummary === undefined
        ? {}
        : { previousSummary: { ...this.#previousSummary } }),
      ...(this.#openLoopSpanId === undefined ? {} : { openLoopSpanId: this.#openLoopSpanId }),
      nextRawItemId: this.#nextRawItemId,
      nextSpanId: this.#nextSpanId,
      nextEntryId: this.#nextEntryId,
    };
  }

  /**
   * Restore a checkpoint without mutating it. Structural, relationship,
   * protocol, and version checks all complete before the first codec decode.
   */
  static restoreCheckpoint<P extends AgentProtocol>(
    checkpoint: ContextStoreCheckpointV1,
    codec: AgentProtocolCheckpointCodec<P>,
  ): ContextStore<P> {
    assertCheckpointCodec(codec);
    validateContextStoreCheckpoint(checkpoint, codec);

    const decode = (value: JsonValue, label: string): ContextOf<P> => {
      let context: readonly ContextOf<P>[];

      try {
        context = codec.decode(cloneJsonValue(value, label));
      } catch (error) {
        // Transient same-process codecs intentionally signal that their opaque
        // payload is unavailable to a replacement Agent instance. Preserve the
        // stable control-plane error so callers can distinguish that boundary
        // from a corrupt durable checkpoint.
        if (
          typeof error === 'object' &&
          error !== null &&
          Reflect.get(error, 'code') === 'RECOVERY_UNSUPPORTED'
        ) {
          throw error;
        }
        throw new ContextStoreError(
          'invalid_context_checkpoint',
          `${label} could not be decoded by ${codec.protocol}@${codec.version}: ${errorMessage(error)}`,
        );
      }

      if (!Array.isArray(context) || context.length !== 1) {
        throw new ContextStoreError(
          'invalid_context_checkpoint',
          `${label} must decode to exactly one protocol context item.`,
        );
      }

      return context[0] as ContextOf<P>;
    };

    // Decode into detached local state first. A later decode failure therefore
    // cannot expose a partially restored store.
    const rawHistory = checkpoint.rawHistory.map((item, index) =>
      decode(item.value, `rawHistory[${index}].value`),
    );
    const rawHistoryIndexById = new Map(
      checkpoint.rawHistory.map((item, index) => [item.itemId, index] as const),
    );
    const activeSpans: MutableContextSpan<P>[] = checkpoint.activeSpans.map((span, spanIndex) => ({
      spanId: span.spanId,
      kind: span.kind,
      closed: span.closed,
      originalContext: span.originalContext.map((value, originalIndex) =>
        decode(value, `activeSpans[${spanIndex}].originalContext[${originalIndex}]`),
      ),
      entries: span.entries.map((entry, entryIndex) => ({
        entryId: entry.entryId,
        spanId: entry.spanId,
        kind: entry.kind,
        active: decode(entry.active, `activeSpans[${spanIndex}].entries[${entryIndex}].active`),
        ...(entry.rawItemId === undefined
          ? {}
          : {
              rawItemId: entry.rawItemId,
              rawHistoryIndex: rawHistoryIndexById.get(entry.rawItemId) as number,
            }),
        ...(entry.original === undefined
          ? {}
          : {
              original: decode(
                entry.original,
                `activeSpans[${spanIndex}].entries[${entryIndex}].original`,
              ),
            }),
      })),
    }));

    const store = new ContextStore<P>();
    store.#rawHistory = rawHistory;
    store.#rawItemIds = checkpoint.rawHistory.map((item) => item.itemId);
    store.#activeSpans = activeSpans;
    store.#summaryBoundarySpanId = checkpoint.summaryBoundarySpanId;
    store.#previousSummary = checkpoint.previousSummary
      ? { ...checkpoint.previousSummary }
      : undefined;
    store.#openLoopSpanId = checkpoint.openLoopSpanId;
    store.#revision = checkpoint.revision;
    store.#nextRawItemId = checkpoint.nextRawItemId;
    store.#nextSpanId = checkpoint.nextSpanId;
    store.#nextEntryId = checkpoint.nextEntryId;
    return store;
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
    const rawItemId = this.#newRawItemId();
    this.#rawItemIds.push(rawItemId);
    const span = this.#newSpan(kind, true, [message]);
    span.entries.push(this.#newEntry(span, message, rawHistoryIndex, message, rawItemId));
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
    const rawItemId = this.#newRawItemId();
    this.#rawItemIds.push(rawItemId);

    span.originalContext.push(message);
    span.entries.push(this.#newEntry(span, message, rawHistoryIndex, message, rawItemId));
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

    if (entry.rawItemId !== undefined) {
      const rawHistoryIndex = this.#rawItemIds.indexOf(entry.rawItemId);

      if (rawHistoryIndex >= 0) {
        return this.#rawHistory[rawHistoryIndex] as ContextOf<P>;
      }
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
    rawItemId: string | undefined = rawHistoryIndex === undefined
      ? undefined
      : this.#rawItemIds[rawHistoryIndex],
  ): MutableActiveContextEntry<P> {
    return {
      entryId: `context-entry-${this.#nextEntryId++}`,
      spanId: span.spanId,
      kind: span.kind,
      active,
      ...(rawItemId === undefined ? {} : { rawItemId }),
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

  #newRawItemId(): string {
    return `context-raw-item-${this.#nextRawItemId++}`;
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

const CONTEXT_ENTRY_KINDS = new Set<ContextEntryKind>([
  'seed',
  'user',
  'external',
  'loop',
  'summary',
  'preserved',
]);

function checkpointError(message: string): never {
  throw new ContextStoreError('invalid_context_checkpoint', message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cloneJsonValue(value: unknown, label: string): JsonValue {
  try {
    assertJsonValue(value);
    return parseJsonValue(canonicalizeJson(value));
  } catch (error) {
    throw new ContextStoreError(
      'invalid_context_checkpoint',
      `${label} is not a JSON-safe value: ${errorMessage(error)}`,
    );
  }
}

function assertCheckpointCodec<P extends AgentProtocol>(
  codec: AgentProtocolCheckpointCodec<P>,
): void {
  if (
    typeof codec !== 'object' ||
    codec === null ||
    typeof codec.protocol !== 'string' ||
    codec.protocol.length === 0 ||
    typeof codec.version !== 'string' ||
    codec.version.length === 0 ||
    typeof codec.encode !== 'function' ||
    typeof codec.decode !== 'function'
  ) {
    throw new TypeError(
      'A protocol checkpoint codec requires protocol, version, encode, and decode.',
    );
  }
}

function assertNonNegativeSafeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    checkpointError(`${label} must be a non-negative safe integer.`);
  }
}

function assertPositiveSafeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    checkpointError(`${label} must be a positive safe integer.`);
  }
}

function parseGeneratedId(id: unknown, prefix: string, label: string): number {
  if (typeof id !== 'string') {
    checkpointError(`${label} must be a string.`);
  }

  const match = new RegExp(`^${prefix}(\\d+)$`, 'u').exec(id);
  const numericId = match?.[1] === undefined ? Number.NaN : Number(match[1]);

  if (!Number.isSafeInteger(numericId) || numericId <= 0) {
    checkpointError(`${label} is not a valid generated ID.`);
  }

  return numericId;
}

function assertUniqueId(ids: Set<string>, id: string, label: string): void {
  if (ids.has(id)) {
    checkpointError(`${label} duplicates ${id}.`);
  }
  ids.add(id);
}

function validateContextStoreCheckpoint<P extends AgentProtocol>(
  checkpoint: ContextStoreCheckpointV1,
  codec: AgentProtocolCheckpointCodec<P>,
): void {
  // Validate the complete JSON boundary first. This rejects accessors, proxies,
  // cycles, sparse arrays, undefined properties, and other non-durable values.
  try {
    assertJsonValue(checkpoint as unknown);
  } catch (error) {
    checkpointError(`Context checkpoint is not JSON-safe: ${errorMessage(error)}`);
  }

  if (checkpoint.version !== '1') {
    throw new ContextStoreError(
      'context_checkpoint_version_mismatch',
      `Unsupported ContextStore checkpoint version ${String(checkpoint.version)}.`,
    );
  }
  if (checkpoint.protocol !== codec.protocol || checkpoint.codecVersion !== codec.version) {
    throw new ContextStoreError(
      'context_checkpoint_codec_mismatch',
      `Checkpoint requires ${checkpoint.protocol}@${checkpoint.codecVersion}; received ${codec.protocol}@${codec.version}.`,
    );
  }

  assertNonNegativeSafeInteger(checkpoint.revision, 'revision');
  assertPositiveSafeInteger(checkpoint.nextRawItemId, 'nextRawItemId');
  assertPositiveSafeInteger(checkpoint.nextSpanId, 'nextSpanId');
  assertPositiveSafeInteger(checkpoint.nextEntryId, 'nextEntryId');

  if (!Array.isArray(checkpoint.rawHistory)) {
    checkpointError('rawHistory must be an array.');
  }
  if (!Array.isArray(checkpoint.activeSpans) || checkpoint.activeSpans.length === 0) {
    checkpointError('activeSpans must be a non-empty array.');
  }

  const rawItemIds = new Set<string>();
  let maxRawItemId = 0;
  checkpoint.rawHistory.forEach((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      checkpointError(`rawHistory[${index}] must be an object.`);
    }
    const numericId = parseGeneratedId(
      item.itemId,
      'context-raw-item-',
      `rawHistory[${index}].itemId`,
    );
    assertUniqueId(rawItemIds, item.itemId, `rawHistory[${index}].itemId`);
    maxRawItemId = Math.max(maxRawItemId, numericId);
  });

  const spanIds = new Set<string>();
  const entryIds = new Set<string>();
  const openSpanIds: string[] = [];
  let maxSpanId = 0;
  let maxEntryId = 0;

  checkpoint.activeSpans.forEach((span, spanIndex) => {
    if (typeof span !== 'object' || span === null || Array.isArray(span)) {
      checkpointError(`activeSpans[${spanIndex}] must be an object.`);
    }
    const numericSpanId = parseGeneratedId(
      span.spanId,
      'context-span-',
      `activeSpans[${spanIndex}].spanId`,
    );
    assertUniqueId(spanIds, span.spanId, `activeSpans[${spanIndex}].spanId`);
    maxSpanId = Math.max(maxSpanId, numericSpanId);

    if (!CONTEXT_ENTRY_KINDS.has(span.kind)) {
      checkpointError(`activeSpans[${spanIndex}].kind is invalid.`);
    }
    if (typeof span.closed !== 'boolean') {
      checkpointError(`activeSpans[${spanIndex}].closed must be boolean.`);
    }
    if (!span.closed) openSpanIds.push(span.spanId);
    if (!Array.isArray(span.originalContext) || !Array.isArray(span.entries)) {
      checkpointError(`activeSpans[${spanIndex}] contexts and entries must be arrays.`);
    }

    span.entries.forEach((entry: (typeof span.entries)[number], entryIndex: number) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        checkpointError(`activeSpans[${spanIndex}].entries[${entryIndex}] must be an object.`);
      }
      const numericEntryId = parseGeneratedId(
        entry.entryId,
        'context-entry-',
        `activeSpans[${spanIndex}].entries[${entryIndex}].entryId`,
      );
      assertUniqueId(
        entryIds,
        entry.entryId,
        `activeSpans[${spanIndex}].entries[${entryIndex}].entryId`,
      );
      maxEntryId = Math.max(maxEntryId, numericEntryId);

      if (entry.spanId !== span.spanId || entry.kind !== span.kind) {
        checkpointError(
          `activeSpans[${spanIndex}].entries[${entryIndex}] provenance does not match its span.`,
        );
      }
      if (entry.rawItemId !== undefined && !rawItemIds.has(entry.rawItemId)) {
        checkpointError(`activeSpans[${spanIndex}].entries[${entryIndex}].rawItemId is unknown.`);
      }
    });
  });

  if (checkpoint.nextRawItemId <= maxRawItemId) {
    checkpointError('nextRawItemId must be greater than every persisted raw item ID.');
  }
  if (checkpoint.nextSpanId <= maxSpanId) {
    checkpointError('nextSpanId must be greater than every persisted span ID.');
  }
  if (checkpoint.nextEntryId <= maxEntryId) {
    checkpointError('nextEntryId must be greater than every persisted entry ID.');
  }

  if (checkpoint.openLoopSpanId === undefined) {
    if (openSpanIds.length !== 0) {
      checkpointError('An unclosed span requires openLoopSpanId.');
    }
  } else {
    const lastSpan = checkpoint.activeSpans.at(-1);
    if (
      openSpanIds.length !== 1 ||
      openSpanIds[0] !== checkpoint.openLoopSpanId ||
      lastSpan?.spanId !== checkpoint.openLoopSpanId ||
      lastSpan.kind !== 'loop'
    ) {
      checkpointError('openLoopSpanId must identify the single trailing open loop span.');
    }
  }

  const hasBoundary = checkpoint.summaryBoundarySpanId !== undefined;
  const hasPreviousSummary = checkpoint.previousSummary !== undefined;
  if (hasBoundary !== hasPreviousSummary) {
    checkpointError('summaryBoundarySpanId and previousSummary must appear together.');
  }
  if (checkpoint.summaryBoundarySpanId !== undefined && checkpoint.previousSummary !== undefined) {
    const summarySpan = checkpoint.activeSpans[0];
    if (
      summarySpan?.spanId !== checkpoint.summaryBoundarySpanId ||
      summarySpan.kind !== 'summary' ||
      !summarySpan.closed ||
      summarySpan.entries.length !== 1 ||
      summarySpan.entries[0]?.entryId !== checkpoint.previousSummary.entryId ||
      typeof checkpoint.previousSummary.text !== 'string'
    ) {
      checkpointError('The rolling summary boundary or previousSummary provenance is invalid.');
    }
  }
}
