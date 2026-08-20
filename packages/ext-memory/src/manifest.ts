import {
  MEMORY_INPUT_MANIFEST_VERSION,
  type MemoryInputManifest,
  type MemoryInputManifestOptions,
  type MemoryInputSession,
} from './contracts.js';

const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;

export function createMemoryInputManifest({
  baseMemoryFingerprint,
  sessions,
  createdAt = new Date().toISOString(),
}: MemoryInputManifestOptions): MemoryInputManifest {
  const normalized = normalizeSessions(sessions);
  if (!DIGEST_PATTERN.test(baseMemoryFingerprint)) {
    throw new Error('Memory input base fingerprint must be a SHA-256 digest');
  }
  if (Number.isNaN(Date.parse(createdAt))) throw new Error('Memory input createdAt must be an ISO timestamp');
  return {
    version: MEMORY_INPUT_MANIFEST_VERSION,
    createdAt,
    baseMemoryFingerprint,
    sessions: normalized,
  };
}

export function parseMemoryInputManifest(value: unknown): MemoryInputManifest {
  if (!isRecord(value) || value.version !== MEMORY_INPUT_MANIFEST_VERSION) {
    throw new Error('Unsupported memory input manifest version');
  }
  if (typeof value.createdAt !== 'string' || Number.isNaN(Date.parse(value.createdAt))) {
    throw new Error('Memory input manifest createdAt is invalid');
  }
  if (typeof value.baseMemoryFingerprint !== 'string' || !DIGEST_PATTERN.test(value.baseMemoryFingerprint)) {
    throw new Error('Memory input manifest base fingerprint is invalid');
  }
  if (!Array.isArray(value.sessions)) throw new Error('Memory input manifest sessions must be an array');
  return {
    version: MEMORY_INPUT_MANIFEST_VERSION,
    createdAt: value.createdAt,
    baseMemoryFingerprint: value.baseMemoryFingerprint,
    sessions: normalizeSessions(value.sessions),
  };
}

export function memoryInputSessionIds(manifest: MemoryInputManifest): readonly string[] {
  return manifest.sessions.map(({ checkpoint }) => checkpoint.sessionId);
}

function normalizeSessions(value: readonly unknown[]): readonly MemoryInputSession[] {
  const seen = new Set<string>();
  const sessions: MemoryInputSession[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) throw new Error('Memory input session must be an object');
    const checkpoint = raw.checkpoint;
    if (!isRecord(checkpoint)) throw new Error('Memory input session checkpoint is missing');
    const sessionId = stringField(checkpoint, 'sessionId');
    const sessionFile = stringField(checkpoint, 'sessionFile');
    const leafId = checkpoint.leafId === null ? null : stringField(checkpoint, 'leafId');
    const transcriptDigest = stringField(checkpoint, 'transcriptDigest');
    if (!DIGEST_PATTERN.test(transcriptDigest)) throw new Error(`Invalid transcript digest for ${sessionId}`);
    const metadataPath = stringField(raw, 'metadataPath');
    const transcriptPath = stringField(raw, 'transcriptPath');
    if (!isSafeInputPath(metadataPath) || !isSafeInputPath(transcriptPath)) {
      throw new Error(`Unsafe memory input path for ${sessionId}`);
    }
    if (typeof raw.materializedDigest !== 'string' || !DIGEST_PATTERN.test(raw.materializedDigest)) {
      throw new Error(`Invalid materialized transcript digest for ${sessionId}`);
    }
    const byteLength = raw.byteLength;
    if (typeof byteLength !== 'number' || !Number.isSafeInteger(byteLength) || byteLength < 0) {
      throw new Error(`Invalid materialized transcript byte length for ${sessionId}`);
    }
    const redactionCount = raw.redactionCount;
    if (typeof redactionCount !== 'number' || !Number.isSafeInteger(redactionCount) || redactionCount < 0) {
      throw new Error(`Invalid transcript redaction count for ${sessionId}`);
    }
    if (seen.has(sessionId)) throw new Error(`Duplicate memory input session: ${sessionId}`);
    seen.add(sessionId);
    sessions.push({
      checkpoint: { sessionId, sessionFile, leafId, transcriptDigest },
      metadataPath,
      transcriptPath,
      materializedDigest: raw.materializedDigest,
      byteLength,
      redactionCount,
    });
  }
  return sessions.sort((left, right) => left.checkpoint.sessionId.localeCompare(right.checkpoint.sessionId));
}

export function isSafeInputPath(path: string): boolean {
  if (!path || path.startsWith('/') || path.includes('\\') || path.includes('//')) return false;
  const parts = path.split('/');
  return parts.every((part) => part.length > 0 && part !== '.' && part !== '..' && /^[A-Za-z0-9._-]+$/u.test(part));
}

function stringField(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Memory input ${field} must be a non-empty string`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
