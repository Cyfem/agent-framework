import type { ToolDefinition, ToolRuntimeDefinition } from '../types';

const decoratedTools = new WeakMap<object, ToolRuntimeDefinition[]>();

export function Tool(definition: ToolDefinition) {
  return function (value: unknown, context: ClassMethodDecoratorContext) {
    if (context.kind !== 'method' || typeof value !== 'function') {
      throw new Error('@Tool can only decorate methods.');
    }

    const method = value as (this: object, parameters: unknown) => unknown | Promise<unknown>;

    context.addInitializer(function (this: unknown) {
      if (typeof this !== 'object' || this === null) {
        return;
      }

      const tools = decoratedTools.get(this) ?? [];

      tools.push({
        ...definition,
        handler: method.bind(this),
      });

      decoratedTools.set(this, tools);
    });
  };
}

export function getDecoratedTools(instance: object): ToolRuntimeDefinition[] {
  return [...(decoratedTools.get(instance) ?? [])];
}
