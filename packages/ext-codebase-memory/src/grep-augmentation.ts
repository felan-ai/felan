import type { ExtensionContext, FelanExtensionAPI } from '@felan-ai/agent-core';
import type { CodebaseMemoryTelemetry } from './cache.js';
import type { CbmClient } from './client.js';
import type { ProjectService } from './services.js';

const GREP_AUGMENT_TIMEOUT_MS = 1_500;
const COMMAND_TOOLS = ['bash', 'exec_command'] as const;

export function registerGrepAugmentation(
  pi: FelanExtensionAPI,
  client: CbmClient,
  projects: ProjectService,
  telemetry: CodebaseMemoryTelemetry,
): void {
  const patterns = new Map<string, { pattern: string; tool: string }>();
  pi.on('tool_call', (event) => {
    if (!COMMAND_TOOLS.includes(event.toolName as typeof COMMAND_TOOLS[number])) return;
    const command = readCommand(event.toolName, event.input);
    const pattern = command ? grepPattern(command) : undefined;
    if (pattern) patterns.set(event.toolCallId, { pattern, tool: event.toolName });
  });
  pi.on('tool_result', async (event: any, _ctx: ExtensionContext) => {
    const pending = patterns.get(event.toolCallId);
    if (!pending) return undefined;
    patterns.delete(event.toolCallId);
    if (event.isError) return undefined;
    const startedAt = Date.now();
    try {
      const project = await projects.project(undefined, remainingMs(startedAt));
      const result = await client.call('search_code', {
        project,
        pattern: pending.pattern,
        context: 2,
        limit: 20,
        max_symbol_lines: 220,
      }, { timeoutMs: remainingMs(startedAt) });
      const text = typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2);
      const hit = hasResults(result.data);
      telemetry('grep_augmentation', {
        tool: pending.tool,
        hit,
        durationMs: Date.now() - startedAt,
        deadlineMs: GREP_AUGMENT_TIMEOUT_MS,
      });
      if (!hit) return undefined;
      return {
        content: [
          ...event.content,
          { type: 'text', text: `Codebase Memory augmentation (possibly stale; grep remains authoritative):\n${text}` },
        ],
      };
    } catch {
      telemetry('grep_augmentation', {
        tool: pending.tool,
        hit: false,
        error: true,
        durationMs: Date.now() - startedAt,
        deadlineMs: GREP_AUGMENT_TIMEOUT_MS,
      });
      return undefined;
    }
  });
}

function remainingMs(startedAt: number): number {
  return Math.max(1, GREP_AUGMENT_TIMEOUT_MS - (Date.now() - startedAt));
}

function readCommand(tool: string, input: Record<string, unknown>): string | undefined {
  const value = tool === 'exec_command' ? input.cmd : input.command;
  return typeof value === 'string' ? value : undefined;
}

function grepPattern(command: string): string | undefined {
  const segment = command.split(/(?:&&|;|\|\|)/u).find((part) => /(?:^|\s)(?:grep|rg)(?:\s|$)/u.test(part));
  if (!segment) return undefined;
  const tokens = segment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/gu) ?? [];
  const index = tokens.findIndex((token) => token === 'grep' || token === 'rg');
  const optionsWithValues = new Set([
    '-A', '-B', '-C', '-f', '-g', '-j', '-m', '-t', '-T',
    '--after-context', '--before-context', '--context', '--encoding', '--engine',
    '--file', '--glob', '--iglob', '--max-count', '--sort', '--sortr', '--threads',
    '--type', '--type-not',
  ]);
  for (let position = index + 1; position < tokens.length; position += 1) {
    const token = tokens[position]!;
    if (token === '-e' || token === '--regexp') return unquote(tokens[position + 1]);
    if (optionsWithValues.has(token)) {
      position += 1;
      continue;
    }
    if (token.startsWith('-')) continue;
    return unquote(token);
  }
  return undefined;
}

function unquote(token: string | undefined): string | undefined {
  return token?.replace(/^(['"])(.*)\1$/u, '$2');
}

function hasResults(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (!value || typeof value !== 'object') return false;
  const results = Reflect.get(value, 'results');
  return Array.isArray(results) ? results.length > 0 : true;
}
