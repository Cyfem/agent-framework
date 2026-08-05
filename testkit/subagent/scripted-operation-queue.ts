export interface ScriptedOperationSpec {
  readonly input: unknown;
  readonly output: unknown;
}

export type ScriptedOperationMap = Record<string, ScriptedOperationSpec>;

type OperationName<Operations extends ScriptedOperationMap> = Extract<keyof Operations, string>;
type OperationInput<
  Operations extends ScriptedOperationMap,
  Name extends OperationName<Operations>,
> = Operations[Name]['input'];
type OperationOutput<
  Operations extends ScriptedOperationMap,
  Name extends OperationName<Operations>,
> = Operations[Name]['output'];

export interface ScriptedOperationInvocation<Name extends string = string, Input = unknown> {
  readonly sequence: number;
  readonly operation: Name;
  readonly input: Input;
}

export interface ScriptedOperationObservation<
  Name extends string = string,
  Input = unknown,
> extends ScriptedOperationInvocation<Name, Input> {
  readonly status: 'running' | 'succeeded' | 'failed';
}

type OperationHandler<
  Operations extends ScriptedOperationMap,
  Name extends OperationName<Operations>,
> = (
  input: OperationInput<Operations, Name>,
  invocation: ScriptedOperationInvocation<Name, OperationInput<Operations, Name>>,
) => OperationOutput<Operations, Name> | Promise<OperationOutput<Operations, Name>>;

interface StoredStep {
  readonly operation: string;
  readonly handler: (input: unknown, invocation: ScriptedOperationInvocation) => unknown;
}

interface MutableObservation extends ScriptedOperationInvocation {
  status: 'running' | 'succeeded' | 'failed';
}

export class UnexpectedScriptedOperationError extends Error {
  readonly code = 'UNEXPECTED_SCRIPTED_OPERATION';
  readonly expectedOperation: string | undefined;
  readonly actualOperation: string;

  constructor(actualOperation: string, expectedOperation?: string) {
    super(
      expectedOperation
        ? `Expected scripted operation "${expectedOperation}", received "${actualOperation}".`
        : `No scripted operation remains for "${actualOperation}".`,
    );
    this.name = 'UnexpectedScriptedOperationError';
    this.expectedOperation = expectedOperation;
    this.actualOperation = actualOperation;
  }
}

/** Strict FIFO script used by fake stores, executors, and transports. */
export class ScriptedOperationQueue<
  Operations extends ScriptedOperationMap = ScriptedOperationMap,
> {
  readonly #steps: StoredStep[] = [];
  readonly #observations: MutableObservation[] = [];
  #sequence = 0;

  get size(): number {
    return this.#steps.length;
  }

  get pendingOperations(): readonly string[] {
    return Object.freeze(this.#steps.map((step) => step.operation));
  }

  get observations(): readonly Readonly<ScriptedOperationObservation>[] {
    return Object.freeze(
      this.#observations.map((observation) =>
        Object.freeze({
          sequence: observation.sequence,
          operation: observation.operation,
          input: observation.input,
          status: observation.status,
        }),
      ),
    );
  }

  enqueue<Name extends OperationName<Operations>>(
    operation: Name,
    handler: OperationHandler<Operations, Name>,
  ): this {
    this.#steps.push({
      operation,
      handler: handler as StoredStep['handler'],
    });
    return this;
  }

  enqueueResult<Name extends OperationName<Operations>>(
    operation: Name,
    output: OperationOutput<Operations, Name>,
  ): this {
    return this.enqueue(operation, () => output);
  }

  enqueueError<Name extends OperationName<Operations>>(operation: Name, error: unknown): this {
    return this.enqueue(operation, () => {
      throw error;
    });
  }

  async execute<Name extends OperationName<Operations>>(
    operation: Name,
    input: OperationInput<Operations, Name>,
  ): Promise<OperationOutput<Operations, Name>> {
    const next = this.#steps[0];
    if (!next || next.operation !== operation) {
      throw new UnexpectedScriptedOperationError(operation, next?.operation);
    }

    this.#steps.shift();
    const invocation = Object.freeze({
      sequence: this.#sequence++,
      operation,
      input,
    });
    const observation: MutableObservation = { ...invocation, status: 'running' };
    this.#observations.push(observation);

    try {
      const result = await next.handler(input, invocation);
      observation.status = 'succeeded';
      return result as OperationOutput<Operations, Name>;
    } catch (error) {
      observation.status = 'failed';
      throw error;
    }
  }

  assertDrained(): void {
    if (this.#steps.length > 0) {
      throw new Error(`Unconsumed scripted operations: ${this.pendingOperations.join(', ')}.`);
    }
  }
}
