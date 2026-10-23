import { sanitizeText } from './bounds.js';

export interface CompactionFileLists {
  readonly readFiles: readonly string[];
  readonly modifiedFiles: readonly string[];
}

export const MAX_FILE_LIST_ENTRIES = 200;
export const MAX_FILE_PATH_BYTES = 1_024;

export function collectFileLists(fileOps: unknown, previousCompactionDetails: unknown): CompactionFileLists {
  const read = new Set<string>();
  const modified = new Set<string>();
  if (isRecord(fileOps)) {
    addPaths(read, fileOps.read);
    addPaths(modified, fileOps.written);
    addPaths(modified, fileOps.edited);
  }
  if (isRecord(previousCompactionDetails)) {
    if (Array.isArray(previousCompactionDetails.readFiles)) addPaths(read, previousCompactionDetails.readFiles);
    if (Array.isArray(previousCompactionDetails.modifiedFiles)) addPaths(modified, previousCompactionDetails.modifiedFiles);
  }
  return {
    readFiles: [...read].filter((path) => !modified.has(path)).sort().slice(0, MAX_FILE_LIST_ENTRIES),
    modifiedFiles: [...modified].sort().slice(0, MAX_FILE_LIST_ENTRIES),
  };
}

export function formatFileLists(lists: CompactionFileLists): string {
  const sections: string[] = [];
  if (lists.readFiles.length > 0) sections.push(`<read-files>\n${lists.readFiles.join('\n')}\n</read-files>`);
  if (lists.modifiedFiles.length > 0) sections.push(`<modified-files>\n${lists.modifiedFiles.join('\n')}\n</modified-files>`);
  return sections.length > 0 ? `\n\n${sections.join('\n\n')}` : '';
}

export function stripFileLists(text: string): string {
  return text.replace(/<(read-files|modified-files)>[\s\S]*?<\/\1>/giu, '').trim();
}

export function latestCompactionDetails(entries: readonly { type: string; details?: unknown }[]): unknown {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type === 'compaction') return entry.details;
  }
  return undefined;
}

function addPaths(target: Set<string>, values: unknown): void {
  if (!Array.isArray(values) && !(values instanceof Set)) return;
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const { text } = sanitizeText(value, MAX_FILE_PATH_BYTES);
    if (text && !text.includes('\n')) target.add(text);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
