import type {
  AgentBaseSystemMessage,
  AgentBaseToolCallOutputMessage,
  AgentBaseUserMessage,
  AgentParsedMessage,
  AgentProtocol,
  AgentTextPart,
  AgentToolCall,
  AgentToolDefinitionInput,
} from '../../src/agent/types';
import { Model } from '../../src/llm/base';
import type { ModelGenerateRequest, ModelGenerateResult } from '../../src/llm/base/types';

export interface TestRawToolCall {
  readonly id: string;
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly arguments: string;
  };
}

export interface TestUserMessage {
  readonly content: readonly AgentTextPart[];
}

export interface TestSystemMessage {
  readonly content: string;
}

export interface TestAssistantMessage {
  readonly content: readonly AgentTextPart[];
}

export interface TestToolOutputMessage {
  readonly callId: string;
  readonly output: string;
}

export type TestContext =
  | {
      readonly kind: 'user';
      readonly content: string;
    }
  | {
      readonly kind: 'system';
      readonly content: string;
    }
  | {
      readonly kind: 'assistant';
      readonly content: string;
      readonly calls?: readonly TestRawToolCall[];
    }
  | {
      readonly kind: 'tool';
      readonly callId: string;
      readonly output: string;
    };

export interface TestProtocol extends AgentProtocol {
  context: TestContext;
  tool: AgentToolDefinitionInput;
  userMessage: TestUserMessage;
  systemMessage: TestSystemMessage;
  assistantMessage: TestAssistantMessage;
  toolCallOutputMessage: TestToolOutputMessage;
  rawToolCall: TestRawToolCall;
  rawResponse: { readonly fixture?: string };
}

export type MockGenerateEntry =
  | ModelGenerateResult<TestProtocol>
  | Error
  | ((
      request: ModelGenerateRequest<TestProtocol>,
      requestNumber: number,
    ) => ModelGenerateResult<TestProtocol> | Promise<ModelGenerateResult<TestProtocol>>);

/**
 * A deliberately old-style custom Model: it implements only the original abstract
 * builder/parser/generate surface and inherits all newly added optional capabilities.
 */
export class MockModel extends Model<TestProtocol> {
  readonly requests: ModelGenerateRequest<TestProtocol>[] = [];

  constructor(private readonly entries: MockGenerateEntry[] = []) {
    super();
  }

  enqueue(...entries: MockGenerateEntry[]): void {
    this.entries.push(...entries);
  }

  async generate(
    request: ModelGenerateRequest<TestProtocol>,
  ): Promise<ModelGenerateResult<TestProtocol>> {
    const requestSnapshot: ModelGenerateRequest<TestProtocol> = {
      context: [...request.context],
      tools: [...request.tools],
      ...('purpose' in request ? { purpose: request.purpose } : {}),
    };
    this.requests.push(requestSnapshot);

    const entry = this.entries.shift();

    if (entry === undefined) {
      throw new Error('MockModel response queue is empty.');
    }

    if (entry instanceof Error) {
      throw entry;
    }

    return typeof entry === 'function' ? entry(requestSnapshot, this.requests.length) : entry;
  }

  buildUserMessage(input: AgentBaseUserMessage | TestUserMessage): TestContext {
    return {
      kind: 'user',
      content: input.content.map((part) => part.text).join(''),
    };
  }

  buildSystemMessage(input: AgentBaseSystemMessage | TestSystemMessage): TestContext {
    return { kind: 'system', content: input.content };
  }

  buildToolCallOutputMessage(
    input: AgentBaseToolCallOutputMessage | TestToolOutputMessage,
  ): TestContext {
    return { kind: 'tool', callId: input.callId, output: input.output };
  }

  buildToolMessage(input: AgentToolDefinitionInput): AgentToolDefinitionInput {
    return { ...input };
  }

  parseUserMessages(
    context: readonly TestContext[],
  ): readonly AgentParsedMessage<TestUserMessage, TestContext>[] {
    return context.flatMap((sourceMessage) =>
      sourceMessage.kind === 'user'
        ? [
            {
              message: {
                content: [{ type: 'text' as const, text: sourceMessage.content }],
              },
              sourceMessage,
            },
          ]
        : [],
    );
  }

  parseSystemMessages(
    context: readonly TestContext[],
  ): readonly AgentParsedMessage<TestSystemMessage, TestContext>[] {
    return context.flatMap((sourceMessage) =>
      sourceMessage.kind === 'system'
        ? [{ message: { content: sourceMessage.content }, sourceMessage }]
        : [],
    );
  }

  parseAssistantMessages(
    context: readonly TestContext[],
  ): readonly AgentParsedMessage<TestAssistantMessage, TestContext>[] {
    return context.flatMap((sourceMessage) =>
      sourceMessage.kind === 'assistant'
        ? [
            {
              message: {
                content: [{ type: 'text' as const, text: sourceMessage.content }],
              },
              sourceMessage,
            },
          ]
        : [],
    );
  }

  parseToolCalls(context: readonly TestContext[]): readonly AgentToolCall<TestProtocol>[] {
    return context.flatMap((sourceMessage) =>
      sourceMessage.kind === 'assistant'
        ? (sourceMessage.calls ?? []).map((sourceCall) => ({
            id: sourceCall.id,
            name: sourceCall.function.name,
            arguments: sourceCall.function.arguments,
            sourceMessage,
            sourceCall,
          }))
        : [],
    );
  }

  parseToolCallOutputMessages(
    context: readonly TestContext[],
  ): readonly AgentParsedMessage<TestToolOutputMessage, TestContext>[] {
    return context.flatMap((sourceMessage) =>
      sourceMessage.kind === 'tool'
        ? [
            {
              message: {
                callId: sourceMessage.callId,
                output: sourceMessage.output,
              },
              sourceMessage,
            },
          ]
        : [],
    );
  }
}

export function toolCall(id: string, name: string, argumentsText = '{}'): TestRawToolCall {
  return {
    id,
    type: 'function',
    function: { name, arguments: argumentsText },
  };
}

export function assistant(content: string, calls?: readonly TestRawToolCall[]): TestContext {
  return {
    kind: 'assistant',
    content,
    ...(calls === undefined ? {} : { calls }),
  };
}

export function response(...messages: TestContext[]): ModelGenerateResult<TestProtocol> {
  return { messages };
}

export function endResponse(id = 'end-call'): ModelGenerateResult<TestProtocol> {
  return response(assistant('', [toolCall(id, 'end-agent')]));
}

export function parsedCall(
  id: string,
  name: string,
  argumentsText = '{}',
): AgentToolCall<TestProtocol> {
  const sourceCall = toolCall(id, name, argumentsText);
  const sourceMessage = assistant('', [sourceCall]);

  return {
    id,
    name,
    arguments: argumentsText,
    sourceMessage,
    sourceCall,
  };
}

export function readToolOutput(message: TestContext): string {
  if (message.kind !== 'tool') {
    throw new Error(`Expected tool message, received ${message.kind}.`);
  }

  return message.output;
}
