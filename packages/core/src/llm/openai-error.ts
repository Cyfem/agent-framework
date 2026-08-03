import type { ModelErrorDescriptor } from '../agent/types';

const CONTEXT_LENGTH_IDENTIFIERS = new Set([
  'context_length_exceeded',
  'context_window_exceeded',
  'max_context_length_exceeded',
  'maximum_context_length_exceeded',
]);

const MESSAGE_FALLBACK_STATUSES = new Set([400, 413, 422]);

/**
 * Classify errors produced by OpenAI and OpenAI-compatible SDKs without retaining
 * the provider's raw error object in the public descriptor.
 */
export function classifyOpenAICompatibleError(error: unknown): ModelErrorDescriptor {
  const root = asObject(error);
  const nested = asObject(read(root, 'error'));
  const message = readErrorMessage(error, root, nested);
  const status = readStatus(root);
  const codes = compactStrings(read(root, 'code'), read(nested, 'code'));
  const types = compactStrings(read(root, 'type'), read(nested, 'type'));
  const identifiers = [...codes, ...types];
  const recognizedIdentifier = identifiers.find(isContextLengthIdentifier);
  const providerCode = recognizedIdentifier ?? identifiers[0];
  const messageMayClassify =
    (status === undefined || MESSAGE_FALLBACK_STATUSES.has(status)) &&
    hasExplicitContextLengthMessage(message);

  return {
    kind:
      recognizedIdentifier !== undefined || messageMayClassify
        ? 'context_length_exceeded'
        : 'unknown',
    message,
    provider: 'openai-compatible',
    ...(providerCode === undefined ? {} : { providerCode }),
    ...(status === undefined ? {} : { status }),
    ...readRequestId(root),
  };
}

function asObject(value: unknown): Record<PropertyKey, unknown> | undefined {
  return (typeof value === 'object' && value !== null) || typeof value === 'function'
    ? (value as Record<PropertyKey, unknown>)
    : undefined;
}

function read(object: Record<PropertyKey, unknown> | undefined, property: PropertyKey): unknown {
  if (!object) {
    return undefined;
  }

  try {
    return Reflect.get(object, property);
  } catch {
    return undefined;
  }
}

function compactStrings(...values: unknown[]): string[] {
  return values.flatMap((value) =>
    typeof value === 'string' && value.trim() ? [value.trim()] : [],
  );
}

function isContextLengthIdentifier(identifier: string): boolean {
  return CONTEXT_LENGTH_IDENTIFIERS.has(identifier.trim().toLowerCase());
}

function readStatus(root: Record<PropertyKey, unknown> | undefined): number | undefined {
  for (const value of [read(root, 'status'), read(root, 'statusCode')]) {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599) {
      return value;
    }
  }

  return undefined;
}

function readErrorMessage(
  error: unknown,
  root: Record<PropertyKey, unknown> | undefined,
  nested: Record<PropertyKey, unknown> | undefined,
): string {
  const messages = compactStrings(read(root, 'message'), read(nested, 'message'));
  if (messages[0]) {
    return messages[0];
  }

  if (typeof error === 'string' && error.trim()) {
    return error.trim();
  }

  try {
    return String(error);
  } catch {
    return 'Unknown model error';
  }
}

function readRequestId(
  root: Record<PropertyKey, unknown> | undefined,
): Pick<ModelErrorDescriptor, 'requestId'> {
  const direct = compactStrings(
    read(root, 'requestID'),
    read(root, 'requestId'),
    read(root, 'request_id'),
  )[0];
  if (direct) {
    return { requestId: direct };
  }

  const headers = read(root, 'headers');
  const requestId = readHeader(headers, 'x-request-id') ?? readHeader(headers, 'request-id');
  return requestId ? { requestId } : {};
}

function readHeader(headers: unknown, name: string): string | undefined {
  const object = asObject(headers);
  const get = read(object, 'get');
  if (typeof get === 'function') {
    try {
      const value = Reflect.apply(get, headers, [name]);
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    } catch {
      // Some compatible SDKs expose a partial Headers-like object. Fall through
      // to plain-object lookup if invoking `get` fails.
    }
  }

  if (!object) {
    return undefined;
  }

  for (const key of Reflect.ownKeys(object)) {
    if (typeof key !== 'string' || key.toLowerCase() !== name) {
      continue;
    }

    const value = read(object, key);
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return undefined;
}

function hasExplicitContextLengthMessage(message: string): boolean {
  const normalized = message.toLowerCase();

  return (
    /\b(?:context_length_exceeded|context_window_exceeded|max_context_length_exceeded|maximum_context_length_exceeded)\b/u.test(
      normalized,
    ) ||
    /\b(?:maximum|max) context (?:length|window)\b/u.test(normalized) ||
    /\bcontext (?:length|window)\b[^\n.]{0,96}\b(?:exceed(?:ed|s)?|too (?:large|long)|limit)\b/u.test(
      normalized,
    ) ||
    /\b(?:exceed(?:ed|s)?|too (?:large|long))\b[^\n.]{0,96}\bcontext (?:length|window)\b/u.test(
      normalized,
    ) ||
    /\b(?:input|prompt|messages?)\b[^\n.]{0,96}\btoo (?:large|long)\b[^\n.]{0,96}\b(?:context|tokens?)\b/u.test(
      normalized,
    ) ||
    /\b(?:input|prompt|messages?)\b[^\n.]{0,64}\btoo many tokens\b/u.test(normalized)
  );
}
