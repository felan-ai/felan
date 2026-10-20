export const PROTOCOL_VERSION = 1 as const;
export const ROW_SCHEMA_VERSION = 1 as const;
export const CONTROL_VERSION = 1 as const;

export const LIMITS = Object.freeze({
  depth: 32,
  idBytes: 128,
  commandBytes: 128,
  pathBytes: 4096,
  structuredBytes: 64 * 1024,
  activeStreamBytes: 1024 * 1024,
  activeStreamsBytes: 4 * 1024 * 1024,
  activeStreams: 8,
  processReadBytes: 64 * 1024,
  processWriteBytes: 16 * 1024,
  pageEntries: 256,
  pageBytes: 12 * 1024 * 1024,
  unsentBytes: 32 * 1024 * 1024,
  inflightRequests: 64,
  catalogEntries: 1024,
  requestRetentionMs: 7 * 24 * 60 * 60 * 1000,
  deferredInteractionTtlMs: 30 * 60 * 1000,
  darwinSocketPathBytes: 103,
  linuxSocketPathBytes: 107,
  windowsPipeCharacters: 240,
  statusTextBytes: 64 * 1024,
  instructionsBytes: 16 * 1024,
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

const encoder = new TextEncoder();
const byteBuffer = new Uint8Array(16 * 1024);

export function utf8Bytes(text: string): number {
  let bytes = 0;
  let offset = 0;
  while (offset < text.length) {
    const { read, written } = encoder.encodeInto(offset === 0 ? text : text.slice(offset), byteBuffer);
    bytes += written;
    offset += read;
  }
  return bytes;
}

export function codePointLength(text: string): number {
  let length = text.length;
  for (let index = 0; index < text.length - 1; index++) {
    const first = text.charCodeAt(index);
    if (first < 0xd800 || first > 0xdbff) continue;
    const second = text.charCodeAt(index + 1);
    if (second >= 0xdc00 && second <= 0xdfff) { length--; index++; }
  }
  return length;
}
