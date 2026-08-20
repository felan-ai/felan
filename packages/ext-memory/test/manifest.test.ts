import { describe, expect, it } from 'vitest';
import {
  createMemoryInputManifest,
  memoryInputSessionIds,
  parseMemoryInputManifest,
} from '../src/index.js';

const session = {
  checkpoint: {
    sessionId: 'session-1',
    sessionFile: '/tmp/session-1.jsonl',
    leafId: 'leaf-1',
    transcriptDigest: 'a'.repeat(64),
  },
  metadataPath: 'sessions/session-1/metadata.json',
  transcriptPath: 'sessions/session-1/transcript.jsonl',
  materializedDigest: 'b'.repeat(64),
  byteLength: 12,
  redactionCount: 1,
} as const;

describe('memory input manifests', () => {
  it('sorts sessions and preserves the target boundary', () => {
    const manifest = createMemoryInputManifest({
      baseMemoryFingerprint: 'c'.repeat(64),
      sessions: [session],
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(memoryInputSessionIds(manifest)).toEqual(['session-1']);
    expect(parseMemoryInputManifest(JSON.parse(JSON.stringify(manifest)))).toEqual(manifest);
  });

  it('rejects unsafe input paths and invalid digests', () => {
    expect(() => createMemoryInputManifest({
      baseMemoryFingerprint: 'bad',
      sessions: [session],
    })).toThrow(/base fingerprint/);
    expect(() => parseMemoryInputManifest({
      version: 1,
      createdAt: new Date().toISOString(),
      baseMemoryFingerprint: 'c'.repeat(64),
      sessions: [{ ...session, transcriptPath: '../transcript.jsonl' }],
    })).toThrow(/Unsafe memory input path/);
  });
});
