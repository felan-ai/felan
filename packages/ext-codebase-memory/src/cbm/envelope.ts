export interface CbmEnvelope {
  readonly content?: ReadonlyArray<{ readonly type?: string; readonly text?: string }>;
  readonly isError?: boolean;
}

export function parseCbmEnvelope(stdout: string): { readonly envelope: CbmEnvelope; readonly text: string } {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error('codebase-memory-mcp produced no JSON output');
  const candidates = [trimmed, ...trimmed.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.startsWith('{')).reverse()];
  for (const candidate of candidates) {
    try {
      const envelope = JSON.parse(candidate) as CbmEnvelope;
      if (envelope && typeof envelope === 'object' && (Array.isArray(envelope.content) || 'isError' in envelope)) {
        const text = envelope.content?.find((item) => item.type === 'text' && typeof item.text === 'string')?.text;
        return { envelope, text: text ?? trimmed };
      }
    } catch { /* Ignore diagnostic lines before the final JSON envelope. */ }
  }
  throw new Error(`Could not parse codebase-memory-mcp JSON envelope: ${trimmed.slice(0, 500)}`);
}

export function parseMaybeJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return text;
  try { return JSON.parse(trimmed) as unknown; } catch { return text; }
}
