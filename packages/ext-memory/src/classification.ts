import { extractTranscriptEvidenceEntry } from '@felan-ai/agent-core';
import type { MemoryInputManifest, MemorySnapshot } from './contracts.js';

export interface MemoryCandidate {
  readonly id: string;
  readonly provenance: 'user' | 'assistant' | 'toolResult' | 'compaction' | 'branch_summary' | 'wiki';
  readonly content: string;
  readonly toolName?: string;
  readonly hasNonTextContent?: boolean;
  readonly reference: {
    readonly sessionId: string;
    readonly transcriptPath: string;
    readonly entryId: string;
  } | {
    readonly path: string;
    readonly block: number;
  };
}

export function collectMemoryCandidates(
  manifest: MemoryInputManifest,
  transcripts: readonly string[],
  memory: MemorySnapshot,
): readonly MemoryCandidate[] {
  if (manifest.sessions.length !== transcripts.length) throw new Error('Memory candidate transcripts do not match the manifest');
  const candidates: MemoryCandidate[] = [];
  for (const [sessionIndex, session] of manifest.sessions.entries()) {
    const lines = transcripts[sessionIndex]!.split('\n').filter(Boolean);
    for (const [lineIndex, line] of lines.entries()) {
      const entry: unknown = JSON.parse(line);
      if (!isRecord(entry) || typeof entry.id !== 'string') throw new Error('Invalid staged memory evidence entry');
      const extracted = extractTranscriptEvidenceEntry(entry);
      if (!extracted) continue;
      const { role: provenance, toolName } = extracted;
      const text = extracted.text.join('\n');
      if (!text.trim()) continue;
      candidates.push({
        id: `session_${sessionIndex}_${lineIndex}`,
        provenance,
        content: text,
        ...(toolName === undefined ? {} : { toolName }),
        ...(extracted.nonTextKinds.length ? { hasNonTextContent: true } : {}),
        reference: {
          sessionId: session.checkpoint.sessionId,
          transcriptPath: session.transcriptPath,
          entryId: entry.id,
        },
      });
    }
  }
  for (const [fileIndex, file] of memory.files.entries()) {
    if (file.path !== 'summary.md' && (!file.path.startsWith('pages/') || file.path.endsWith('/index.md'))) continue;
    const blocks = file.content.split(/\n\s*\n/gu);
    let heading = '';
    for (const [blockIndex, block] of blocks.entries()) {
      const text = block.trim();
      if (/^#{1,6}\s+Sources(?:\s|$)/iu.test(text)) break;
      if (/^#{1,6}\s+/u.test(text) && !text.includes('\n')) {
        heading = text;
        continue;
      }
      if (!text) continue;
      candidates.push({
        id: `wiki_${fileIndex}_${blockIndex}`,
        provenance: 'wiki',
        content: `${file.path}\n${heading}\n${text}`,
        reference: { path: file.path, block: blockIndex },
      });
    }
  }
  return candidates;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
