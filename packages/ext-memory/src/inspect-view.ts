import { extractTranscriptEvidenceEntry } from '@felan-ai/agent-core';

export function renderMemoryInspectView(inspectJsonl: string, sessionId: string): string | undefined {
  const blocks: string[] = [];
  for (const line of inspectJsonl.split('\n')) {
    if (!line) continue;
    let record: unknown;
    try { record = JSON.parse(line); } catch { return undefined; }
    const entry = extractTranscriptEvidenceEntry(record);
    if (!entry || !entry.text.length || entry.nonTextKinds.length) return undefined;
    const header = `[source session=${JSON.stringify(sessionId)} entry=${JSON.stringify(entry.entryId)} role=${entry.role}${entry.toolName === undefined ? '' : ` tool=${JSON.stringify(entry.toolName)}`}]`;
    blocks.push(`${header}\n${entry.text.join('\n').split('\n').map((part) => `| ${part}`).join('\n')}\n[/source]`);
  }
  return blocks.length ? `${blocks.join('\n\n')}\n` : '';
}
