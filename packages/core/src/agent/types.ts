export type AgentStatus = 'idle' | 'running' | 'ended' | 'failed';

export type ToolCallErrorTrigger = 'before' | 'calling' | 'after';

export type Unsubscribe = () => void;

export type JsonObject = Record<string, unknown>;

export interface ToolParametersSchema {
  safeParse(data: unknown):
    | {
        success: true;
        data: unknown;
      }
    | {
        success: false;
        error: unknown;
      };
}

export interface AgentSystemMessage {
  role: 'system';
  content: string;
}

export interface AgentUserMessage {
  role: 'user';
  content: string;
}

export interface AgentToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface AgentAssistantMessage {
  role: 'assistant';
  content: string | null;
  toolCalls?: AgentToolCall[];
}

export interface AgentToolMessage {
  role: 'tool';
  content: string;
  toolCallId: string;
}

export type AgentContext =
  | AgentSystemMessage
  | AgentUserMessage
  | AgentAssistantMessage
  | AgentToolMessage;

export interface AgentSkillSop {
  description: string;
  content: string;
}

export interface AgentSkill {
  name: string;
  description: string;
  systemContent?: string;
  sops?: AgentSkillSop[];
}

export interface ToolDescriptionContext {
  skills: readonly AgentSkill[];
  context: readonly AgentContext[];
  history: readonly AgentContext[];
  systemPrompts: readonly string[];
  tool: {
    name: string;
    parameters?: ToolParametersSchema;
  };
}

export type ToolDescription = string | ((ctx: ToolDescriptionContext) => string);

export interface ToolDefinition {
  name: string;
  description: ToolDescription;
  parameters?: ToolParametersSchema;
}

export type ToolHandler = (parameters: unknown) => unknown | Promise<unknown>;

export interface ToolRuntimeDefinition extends ToolDefinition {
  handler: ToolHandler;
}

export interface ModelToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: JsonObject;
  };
}

export interface ModelChoice {
  index: number;
  message: AgentAssistantMessage;
  finishReason?: string | null;
  raw?: unknown;
}

export interface ModelChatRequest {
  messages: readonly AgentContext[];
  tools: readonly ModelToolDefinition[];
}

export interface ModelChatResponse {
  choices: readonly ModelChoice[];
  raw?: unknown;
}

export interface AgentOptions {
  llm: {
    chat(request: ModelChatRequest): Promise<ModelChatResponse>;
  };
  skills?: readonly AgentSkill[];
  systemPrompts?: readonly string[];
  maxIterations?: number;
}

export interface ToolEventOptions {
  await?: boolean;
  errorCancel?: boolean;
}

export type BeforeToolCallCallback = (
  parameters: unknown,
  message: AgentToolCall,
) => void | Promise<void>;

export type AfterToolCallCallback = (
  parameters: unknown,
  message: AgentToolCall,
  result: unknown,
) => void | Promise<void>;

export type ModelResponseCallback = (message: AgentContext) => void | Promise<void>;

export type ToolCallErrorCallback = (
  name: string,
  triggerType: ToolCallErrorTrigger,
  error: unknown,
  parameters: unknown,
  message: AgentToolCall,
  result?: unknown,
) => void | Promise<void>;

export type AgentStatusChangedCallback = (
  rawContext: readonly AgentContext[],
  context: readonly AgentContext[],
) => void | Promise<void>;

export type AgentErrorCallback = (error: Error) => void | Promise<void>;
