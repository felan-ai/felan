import { mapTextContentBlocks, toRecord } from './record-utils.js';
import { stripAnsiFast } from './techniques/ansi.js';

export interface StreamingSanitizationResult {
  readonly changed: boolean;
  readonly result: unknown;
}

export function sanitizeStreamingCommandResult(result: unknown): StreamingSanitizationResult {
  const record = toRecord(result);
  if (!Array.isArray(record.content) || record.content.length === 0) {
    return { changed: false, result };
  }

  const mapped = mapTextContentBlocks(record.content, (block) => {
    const text = stripAnsiFast(block.text);
    return text === block.text ? undefined : text;
  });
  if (!mapped.changed) return { changed: false, result };

  // Pi's observer-style tool execution events retain the result object but do
  // not propagate replacement event fields. Mutate the shared result object so
  // the interactive renderer sees the sanitized blocks.
  record.content = mapped.content;
  return { changed: true, result };
}
