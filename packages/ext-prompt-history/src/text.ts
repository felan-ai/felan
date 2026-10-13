export const PROMPT_HISTORY_TEXT_BYTES = 64 * 1024 * 1024;
const encoder = new TextEncoder();

export function splitPromptHistoryText(value: string): { chunks: string[]; bytes: number } {
  const bytes = encoder.encode(value).length;
  if (bytes > PROMPT_HISTORY_TEXT_BYTES) throw new Error('Selected prompt exceeds the safe display limit. It was not truncated.');
  const chunks: string[] = []; let chunk = ''; let size = 2;
  for (const char of value) {
    const cost = encoder.encode(JSON.stringify(char)).length - 2;
    if (size + cost > 24 * 1024) { chunks.push(chunk); chunk = ''; size = 2; }
    chunk += char; size += cost;
  }
  chunks.push(chunk); return { chunks, bytes };
}
