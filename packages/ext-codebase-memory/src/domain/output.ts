import { buildToolTextResult, type ToolTextResult } from '../cbm/result.js';

export class OutputService {
  constructor(private readonly maxSymbolLines: number) {}

  result(title: string, data: unknown): ToolTextResult {
    return buildToolTextResult(title, compactStrings(data, this.maxSymbolLines));
  }
}

function compactStrings(value: unknown, maxLines: number): unknown {
  if (typeof value === 'string') {
    const lines = value.split('\n');
    if (lines.length <= maxLines) return value;
    const head = Math.ceil(maxLines / 2);
    const tail = Math.floor(maxLines / 2);
    return `${lines.slice(0, head).join('\n')}\n… [${lines.length - maxLines} lines compacted] …\n${lines.slice(-tail).join('\n')}`;
  }
  if (Array.isArray(value)) return value.map((item) => compactStrings(item, maxLines));
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, compactStrings(item, maxLines)]));
}
