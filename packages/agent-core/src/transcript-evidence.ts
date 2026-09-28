export interface TranscriptTextParts {
  readonly text: readonly string[];
  readonly nonTextKinds: readonly string[];
}

export interface TranscriptEvidenceEntry extends TranscriptTextParts {
  readonly entryId: string;
  readonly role: 'user' | 'assistant' | 'toolResult' | 'compaction' | 'branch_summary';
  readonly toolName?: string;
}

export function extractTranscriptTextParts(content: unknown): TranscriptTextParts {
  if (typeof content === 'string') return { text: [content], nonTextKinds: [] };
  if (!Array.isArray(content)) return { text: [], nonTextKinds: ['unsupported-content'] };
  const text: string[] = [];
  const nonTextKinds: string[] = [];
  for (const part of content) {
    if (!isRecord(part) || typeof part.type !== 'string') {
      nonTextKinds.push('unsupported-block');
    } else if (part.type === 'text' && typeof part.text === 'string') {
      text.push(part.text);
    } else {
      nonTextKinds.push(part.type);
    }
  }
  return { text, nonTextKinds };
}

export function extractTranscriptEvidenceEntry(entry: unknown): TranscriptEvidenceEntry | undefined {
  if (!isRecord(entry) || typeof entry.id !== 'string') return undefined;
  if ((entry.type === 'compaction' || entry.type === 'branch_summary') && typeof entry.summary === 'string') {
    return { entryId: entry.id, role: entry.type, text: [entry.summary], nonTextKinds: [] };
  }
  if (entry.type !== 'message' || !isRecord(entry.message)) return undefined;
  const message = entry.message;
  if (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'toolResult') return undefined;
  return {
    entryId: entry.id,
    role: message.role,
    ...(message.role === 'toolResult' && typeof message.toolName === 'string' ? { toolName: message.toolName } : {}),
    ...extractTranscriptTextParts(message.content),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
