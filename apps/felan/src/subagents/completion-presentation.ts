import type { FelanExtensionAPI } from '@felan-ai/agent-core';
import { SESSION_EXECUTION_COMPLETION_MESSAGE_TYPE, type ExecutionCompletionNotice } from '../execution-completion.js';
import type { Theme } from '@earendil-works/pi-coding-agent';
import {
  truncateToWidth,
  type Component,
} from '@earendil-works/pi-tui';

import { MAX_DETAIL_LINES, summaryLines, inlineText, messageText, isRecord } from '../tui/completion-text.js';

interface CompletionMessageDetails {
  readonly notice?: unknown;
  readonly notices?: unknown;
}

export function registerSubagentCompletionRenderer(
  pi: Pick<FelanExtensionAPI, 'registerMessageRenderer'>,
): void {
  pi.registerMessageRenderer<CompletionMessageDetails>(
    SESSION_EXECUTION_COMPLETION_MESSAGE_TYPE,
    (message, options, theme) => new SubagentCompletionComponent(
      completionNotices(message.details),
      messageText(message.content),
      options.expanded,
      options.outputPad,
      theme,
    ),
  );
}

export class SubagentCompletionComponent implements Component {
  readonly #notices: readonly ExecutionCompletionNotice[];
  readonly #detailLines: readonly string[];

  constructor(
    notices: readonly ExecutionCompletionNotice[],
    fallbackText: string,
    private readonly expanded: boolean,
    private readonly outputPad: number,
    private readonly theme: Theme,
  ) {
    this.#notices = notices;
    this.#detailLines = summaryLines(
      notices.length === 1
        ? notices[0]!.summary ?? notices[0]!.error?.message ?? notices[0]!.status
        : notices.length > 1
          ? notices.map((notice) => (
            `${notice.label} ${shortAgentId(notice.executionId)}: ${notice.summary ?? notice.error?.message ?? notice.status}`
          ))
          : fallbackText,
    );
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    const padding = Math.min(
      Math.max(0, this.outputPad),
      Math.max(0, width - 1),
    );
    const availableWidth = Math.max(1, width - padding * 2);
    const leftPadding = ' '.repeat(padding);
    const header = this.#header();
    const lines = [header];

    if (this.expanded) {
      for (const line of this.#detailLines.slice(0, MAX_DETAIL_LINES)) {
        lines.push(this.theme.fg('dim', `  ${line}`));
      }
      if (this.#detailLines.length > MAX_DETAIL_LINES) {
        lines.push(this.theme.fg(
          'dim',
          `  … ${this.#detailLines.length - MAX_DETAIL_LINES} more lines · Alt+A full details`,
        ));
      }
    }

    return lines.map((line) => (
      leftPadding + truncateToWidth(line, availableWidth, '…')
    ));
  }

  invalidate(): void {}

  #header(): string {
    const notices = this.#notices;
    if (notices.length === 0) {
      const summary = this.#detailLines[0];
      return `${this.theme.fg('success', '✓')} ${this.theme.bold('Subagent completed')}`
        + (summary ? this.theme.fg('muted', ` · ${summary}`) : '')
        + this.theme.fg('muted', ' · Alt+A details');
    }

    if (notices.length > 1) {
      return `${this.theme.fg('success', '✓')} ${this.theme.bold(`${notices.length} subagents completed`)} `
        + this.theme.fg('muted', `· ${this.#detailLines[0] ?? ''} · Alt+A details`);
    }
    const notice = notices[0]!;
    const title = `Subagent ${inlineText(notice.label)} ${formatStatus(notice.status)}`;
    const metadata = [shortAgentId(notice.executionId)];
    if (!this.expanded && this.#detailLines[0]) metadata.push(this.#detailLines[0]);
    metadata.push('Alt+A details');
    return `${statusIcon(notice.status, this.theme)} ${this.theme.bold(title)}`
      + this.theme.fg('muted', ` · ${metadata.join(' · ')}`);
  }
}

function completionNotice(value: unknown): ExecutionCompletionNotice | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.deliveryId !== 'string'
    || typeof value.parentSessionId !== 'string'
    || typeof value.executionId !== 'string'
    || typeof value.label !== 'string'
    || !isTerminalStatus(value.status)
    || (value.summary !== undefined && typeof value.summary !== 'string')
    || (
      value.error !== undefined
      && (!isRecord(value.error) || typeof value.error.message !== 'string')
    )
  ) return undefined;
  return value as unknown as ExecutionCompletionNotice;
}

export function completionNotices(details: unknown): ExecutionCompletionNotice[] {
  if (!isRecord(details)) return [];
  const notices = Array.isArray(details?.notices)
    ? details.notices.map(completionNotice).filter(isNotice)
    : [];
  if (notices.length > 0) return notices;
  const notice = completionNotice(details?.notice);
  return notice ? [notice] : [];
}

function isNotice(value: ExecutionCompletionNotice | undefined): value is ExecutionCompletionNotice {
  return value !== undefined;
}

function isTerminalStatus(value: unknown): value is ExecutionCompletionNotice['status'] {
  return value === 'completed'
    || value === 'failed'
    || value === 'timed_out'
    || value === 'cancelled';
}

function statusIcon(status: ExecutionCompletionNotice['status'], theme: Theme): string {
  if (status === 'completed') return theme.fg('success', '✓');
  if (status === 'failed') return theme.fg('error', '✗');
  if (status === 'timed_out') return theme.fg('warning', '◷');
  return theme.fg('dim', '■');
}

function formatStatus(status: ExecutionCompletionNotice['status']): string {
  return status === 'timed_out' ? 'timed out' : status;
}

function shortAgentId(agentId: string): string {
  return inlineText(agentId).slice(0, 8);
}
