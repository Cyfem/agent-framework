import type { ToolDefinition, ToolRuntimeDefinition } from '../types';

const toolDefinitionsMetadataKey = Symbol.for('@manee/agent-framework/toolDefinitions');

interface ToolInitializerReceiver {
  tools?: ToolRuntimeDefinition[];
}

/**
 * 将 Agent 方法声明为可被模型调用的工具。
 *
 * 装饰器在类级 metadata 中记录 `toolsDefinition` 静态定义，并为每个实例
 * 注册绑定后的运行时 handler。
 */
export function Tool(definition: ToolDefinition) {
  return function (value: unknown, context: ClassMethodDecoratorContext) {
    if (context.kind !== 'method' || typeof value !== 'function') {
      throw new Error('@Tool can only decorate methods.');
    }

    const method = value as (this: object, parameters: unknown) => unknown | Promise<unknown>;

    // 2023-11 decorator metadata 位于类级别；写入前复制继承数组，避免子类工具
    // 污染父类的 `toolsDefinition`。
    registerToolDefinition(context.metadata as Record<PropertyKey, unknown>, {
      ...definition,
    });

    // initializer 绑定当前实例，使 private method 也能安全作为运行时工具执行。
    context.addInitializer(function (this: unknown) {
      if (typeof this !== 'object' || this === null) {
        return;
      }

      const receiver = this as ToolInitializerReceiver;

      receiver.tools ??= [];
      receiver.tools.push({
        ...definition,
        handler: method.bind(receiver),
      });
    });
  };
}

/** 获取类构造器的静态工具定义浅拷贝，避免外部修改内部定义数组。 */
export function getToolDefinitions(target: object): ToolDefinition[] {
  const metadata = (target as Record<PropertyKey, unknown>)[getMetadataSymbol()] as
    | Record<PropertyKey, unknown>
    | undefined;
  const definitions = metadata?.[toolDefinitionsMetadataKey];

  return Array.isArray(definitions)
    ? definitions.map((definition) => ({
        ...definition,
      }))
    : [];
}

function registerToolDefinition(
  metadata: Record<PropertyKey, unknown>,
  definition: ToolDefinition,
): void {
  const hasOwnDefinitions = Object.prototype.hasOwnProperty.call(
    metadata,
    toolDefinitionsMetadataKey,
  );
  const currentDefinitions = metadata[toolDefinitionsMetadataKey];
  const definitions =
    hasOwnDefinitions && Array.isArray(currentDefinitions)
      ? currentDefinitions
      : Array.isArray(currentDefinitions)
        ? [...currentDefinitions]
        : [];

  definitions.push(definition);
  metadata[toolDefinitionsMetadataKey] = definitions;
}

function getMetadataSymbol(): symbol {
  return (
    (Symbol as typeof Symbol & { metadata?: symbol }).metadata ?? Symbol.for('Symbol.metadata')
  );
}
