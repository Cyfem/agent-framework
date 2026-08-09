/** Closed JSON packet version used by the HTTP multipart transport. */
export const HTTP_SUBAGENT_PACKET_VERSION = '1' as const;

/** Exact media type of the first multipart part. */
export const HTTP_SUBAGENT_PACKET_MEDIA_TYPE = 'application/vnd.maneeagent.packet+json' as const;

/** Version carried by the six Manee authentication headers. */
export const HTTP_SUBAGENT_AUTH_VERSION = '1' as const;

/** Prefix and first canonical signing line for HMAC-SHA256 v1. */
export const HTTP_SUBAGENT_HMAC_SCHEME = 'MANEE-HMAC-SHA256-V1' as const;

/** Inclusive default past/future timestamp window. */
export const HTTP_SUBAGENT_DEFAULT_CLOCK_SKEW_MS = 60_000;

/** Exact replay-cache lifetime starting at successful verification time. */
export const HTTP_SUBAGENT_REPLAY_TTL_MS = 120_000;

export const HTTP_SUBAGENT_AUTH_HEADER_NAMES = Object.freeze({
  version: 'Manee-Auth-Version',
  keyId: 'Manee-Key-Id',
  timestamp: 'Manee-Timestamp',
  nonce: 'Manee-Nonce',
  bodySha256: 'Manee-Body-SHA256',
  signature: 'Manee-Signature',
} as const);

export type HttpSubAgentAuthHeaderName =
  (typeof HTTP_SUBAGENT_AUTH_HEADER_NAMES)[keyof typeof HTTP_SUBAGENT_AUTH_HEADER_NAMES];
