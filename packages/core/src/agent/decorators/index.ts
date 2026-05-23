import type { ToolDefinition, ToolRuntimeDefinition } from '../types';

const toolDefinitionsMetadataKey = Symbol.for('@manee/agent-framework/toolDefinitions');

interface ToolInitializerReceiver {
  tools?: ToolRuntimeDefinition[];
}

/**
 * Declare an Agent method as a callable tool.
 *
 * The decorator stores static metadata on the class for `toolsDefinition` and
 * registers a bound runtime handler on each instance.
 */
export function Tool(definition: ToolDefinition) {
  return function (value: unknown, context: ClassMethodDecoratorContext) {
    if (context.kind !== 'method' || typeof value !== 'function') {
      throw new Error('@Tool can only decorate methods.');
    }

    const method = value as (this: object, parameters: unknown) => unknown | Promise<unknown>;

    // 2023-11 decorator metadata is class-level. Copy inherited arrays before
    // appending so subclass tools do not mutate parent `toolsDefinition`.
    registerToolDefinition(context.metadata as Record<PropertyKey, unknown>, {
      ...definition,
    });

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

/** Return shallow-copied static tool definitions for a class constructor. */
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
