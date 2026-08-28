import type { CbmClient } from '../cbm/client.js';
import type { ProjectService, ToolExecutionContext } from '../domain/project.js';

interface TextContent { readonly type: 'text'; readonly text: string }
interface OtherContent { readonly type: string; readonly [key: string]: unknown }
export interface AugmentableToolResult {
  readonly toolName: string;
  readonly input: unknown;
  readonly content: Array<TextContent | OtherContent>;
  readonly isError: boolean;
}
export type AugmentationOutcome =
  | { readonly status: 'skipped' | 'error'; readonly reason: string }
  | { readonly status: 'matched'; readonly token: string; readonly content: Array<TextContent | OtherContent> };

export class CbmAugmentService {
  constructor(private readonly cbm: CbmClient, private readonly projects: ProjectService, private readonly timeoutMs: number) {}

  async augmentResult(event: AugmentableToolResult, ctx: ToolExecutionContext): Promise<AugmentationOutcome> {
    try {
      const token = extractSearchToken(event);
      if (!token) return { status: 'skipped', reason: 'not a supported successful search' };
      const project = await this.projects.inferProject(ctx.cwd, ctx.signal);
      const result = await this.cbm.callTool('search_graph', {
        project,
        name_pattern: `.*${escapeRegex(token)}.*`,
        limit: 5,
      }, { signal: ctx.signal, timeoutMs: this.timeoutMs, allowError: true });
      const matches = readResults(result.data).slice(0, 5);
      if (!result.ok || matches.length === 0) return { status: 'skipped', reason: 'no graph matches' };
      const context = [`[codebase-memory] ${matches.length} graph symbol(s) match "${token}":`, ...matches.map(formatMatch)].join('\n').slice(0, 2_000);
      let index = -1;
      for (let candidate = event.content.length - 1; candidate >= 0; candidate--) {
        const item = event.content[candidate]!;
        if (item.type === 'text' && typeof Reflect.get(item, 'text') === 'string') { index = candidate; break; }
      }
      if (index < 0) return { status: 'skipped', reason: 'no text result' };
      const content = event.content.map((item, itemIndex) => itemIndex === index
        ? { ...item, text: `${Reflect.get(item, 'text')}\n\n---\n${context}` } as TextContent
        : item);
      return { status: 'matched', token, content };
    } catch (error) {
      return { status: 'error', reason: error instanceof Error ? error.message : String(error) };
    }
  }
}

function extractSearchToken(event: AugmentableToolResult): string | undefined {
  if (event.isError || !['grep', 'find', 'bash', 'exec_command'].includes(event.toolName) || !isRecord(event.input)) return undefined;
  let source = typeof event.input.pattern === 'string' ? event.input.pattern : undefined;
  const command = typeof event.input.command === 'string' ? event.input.command : typeof event.input.cmd === 'string' ? event.input.cmd : undefined;
  if (!source && command) {
    const match = /(?:^|[;&|]\s*|\s)(?:rg|grep|find|fd)\s+(?:-[^\s]+\s+)*['"]?([^\s'"]+)/u.exec(command);
    source = match?.[1];
  }
  return [...(source ?? '').matchAll(/[A-Za-z_][A-Za-z0-9_]{3,95}/gu)].sort((a, b) => b[0].length - a[0].length)[0]?.[0];
}

function readResults(data: unknown): Array<Record<string, unknown>> {
  if (typeof data !== 'object' || data === null || !Array.isArray(Reflect.get(data, 'results'))) return [];
  return Reflect.get(data, 'results').filter(isRecord);
}
function formatMatch(match: Record<string, unknown>): string {
  const name = String(match.qualified_name ?? match.name ?? 'unknown');
  const path = typeof match.file_path === 'string' ? `  ${match.file_path}${typeof match.start_line === 'number' ? `:${match.start_line}` : ''}` : '';
  return `- ${name}${path}`;
}
function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
