export const PROTOCOL_VERSION = 1 as const;
export const ROW_SCHEMA_VERSION = 1 as const;
export const CONTROL_VERSION = 1 as const;

export const LIMITS = Object.freeze({
  frameBytes: 16 * 1024 * 1024,
  depth: 32,
  promptTextBytes: 1024 * 1024,
  attachments: 16,
  attachmentBytes: 12 * 1024 * 1024,
  idBytes: 128,
  commandBytes: 128,
  pathBytes: 4096,
  structuredBytes: 64 * 1024,
  activeStreamBytes: 1024 * 1024,
  activeStreamsBytes: 4 * 1024 * 1024,
  activeStreams: 8,
  interactionBytes: 256 * 1024,
  answerBytes: 64 * 1024,
  choices: 100,
  wizardPages: 4,
  processReadBytes: 64 * 1024,
  processWriteBytes: 16 * 1024,
  pageEntries: 256,
  pageBytes: 12 * 1024 * 1024,
  unsentBytes: 32 * 1024 * 1024,
  inflightRequests: 64,
  catalogEntries: 1024,
  requestRetentionMs: 7 * 24 * 60 * 60 * 1000,
  requestFutureSkewMs: 5 * 60 * 1000,
  sessionRequestRecords: 100_000,
  namespaceRequestRecords: 1_000_000,
  reservedControlRecords: 1024,
  policyWaitMs: 30_000,
  deferredInteractionTtlMs: 30 * 60 * 1000,
  darwinSocketPathBytes: 103,
  linuxSocketPathBytes: 107,
  windowsPipeCharacters: 240,
  statusTextBytes: 64 * 1024,
});

export class ProtocolValidationError extends Error {
  constructor(
    public readonly code: 'invalid_request' | 'protocol_mismatch' | 'stale_request',
    message: string,
  ) {
    super(message);
    this.name = 'ProtocolValidationError';
  }
}

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

export function codePointLength(text: string): number {
  return Array.from(text).length;
}
