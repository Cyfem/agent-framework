export type HttpSubAgentRouteId =
  | 'heartbeat'
  | 'jobs.create'
  | 'jobs.resume'
  | 'jobs.reconnect'
  | 'jobs.cancel'
  | 'jobs.poll'
  | 'jobs.control-reply';

export type HttpSubAgentRoute =
  | Readonly<{ id: 'heartbeat'; requestTarget: '/v1/heartbeat' }>
  | Readonly<{ id: 'jobs.create'; requestTarget: '/v1/jobs/create' }>
  | Readonly<{
      id: 'jobs.resume' | 'jobs.reconnect' | 'jobs.cancel' | 'jobs.poll';
      requestTarget: string;
      jobId: string;
    }>
  | Readonly<{
      id: 'jobs.control-reply';
      requestTarget: string;
      jobId: string;
      requestId: string;
    }>;

const OPAQUE_ROUTE_ID = '[A-Za-z0-9][A-Za-z0-9._-]{0,127}';
const JOB_ACTION_ROUTE = new RegExp(
  `^/v1/jobs/(${OPAQUE_ROUTE_ID})/(resume|reconnect|cancel|poll)$`,
  'u',
);
const CONTROL_REPLY_ROUTE = new RegExp(
  `^/v1/jobs/(${OPAQUE_ROUTE_ID})/control/(${OPAQUE_ROUTE_ID})/reply$`,
  'u',
);

/** Parses only the seven exact v1 POST routes without normalizing the received request-target. */
export function parseHttpSubAgentRoute(method: unknown, requestTarget: unknown): HttpSubAgentRoute {
  if (method !== 'POST' || typeof requestTarget !== 'string') {
    throw new TypeError('HTTP Subagent v1 only accepts POST on a canonical request-target.');
  }
  assertCanonicalRequestTarget(requestTarget);
  if (requestTarget === '/v1/heartbeat') {
    return Object.freeze({ id: 'heartbeat', requestTarget });
  }
  if (requestTarget === '/v1/jobs/create') {
    return Object.freeze({ id: 'jobs.create', requestTarget });
  }
  const jobAction = JOB_ACTION_ROUTE.exec(requestTarget);
  if (jobAction !== null) {
    const action = jobAction[2] as 'resume' | 'reconnect' | 'cancel' | 'poll';
    return Object.freeze({
      id: `jobs.${action}` as const,
      requestTarget,
      jobId: jobAction[1] as string,
    });
  }
  const controlReply = CONTROL_REPLY_ROUTE.exec(requestTarget);
  if (controlReply !== null) {
    return Object.freeze({
      id: 'jobs.control-reply',
      requestTarget,
      jobId: controlReply[1] as string,
      requestId: controlReply[2] as string,
    });
  }
  throw new TypeError('HTTP Subagent request-target is not a registered v1 route.');
}

function assertCanonicalRequestTarget(value: string): void {
  if (
    value.length < 2 ||
    value.length > 1_024 ||
    value[0] !== '/' ||
    value.endsWith('/') ||
    value.includes('//') ||
    value.includes('?') ||
    value.includes('#') ||
    value.includes('%') ||
    value.includes('\\') ||
    containsNonAsciiOrControl(value)
  ) {
    throw new TypeError('HTTP Subagent request-target is not canonical.');
  }
  for (const segment of value.slice(1).split('/')) {
    if (segment === '.' || segment === '..') {
      throw new TypeError('HTTP Subagent request-target contains a dot segment.');
    }
  }
}

function containsNonAsciiOrControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit >= 0x7f) return true;
  }
  return false;
}
