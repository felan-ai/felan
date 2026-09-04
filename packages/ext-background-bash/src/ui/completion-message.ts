import type { ExtensionContext, FelanExtensionAPI } from '@felan-ai/agent-core';
import {
  stripTerminalSequences,
  truncateToWidth,
  type Component,
} from '@earendil-works/pi-tui';
import type { BackgroundBashStatus } from '../job-store.js';

export const BACKGROUND_BASH_COMPLETION_MESSAGE_TYPE = 'felan-background-bash-completion';

const MAX_DETAIL_LINES = 3;
const MAX_INLINE_CHARACTERS = 240;
const INLINE_CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/gu;

type Theme = ExtensionContext['ui']['theme'];
type TerminalStatus = Exclude<BackgroundBashStatus, 'running'>;

interface CompletionJobDetails {
  readonly id: string;
  readonly status: TerminalStatus;
  readonly command: string;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly error?: string;
}

interface CompletionMessageDetails {
  readonly job?: unknown;
}

export function registerBackgroundBashCompletionRenderer(
  pi: Pick<FelanExtensionAPI, 'registerMessageRenderer'>,
): void {
  pi.registerMessageRenderer<CompletionMessageDetails>(
    BACKGROUND_BASH_COMPLETION_MESSAGE_TYPE,
    (message, options, theme) => new BackgroundBashCompletionComponent(
      completionJob(message.details),
      messageText(message.content),
      options.expanded,
      options.outputPad,
      theme,
    ),
  );
}

export class BackgroundBashCompletionComponent implements Component {
  readonly #detailLines: readonly string[];

  constructor(
    private readonly job: CompletionJobDetails | undefined,
    fallbackText: string,
    private readonly expanded: boolean,
    private readonly outputPad: number,
    private readonly theme: Theme,
  ) {
    this.#detailLines = job ? jobDetailLines(job) : summaryLines(fallbackText);
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    const padding = Math.min(Math.max(0, this.outputPad), Math.max(0, width - 1));
    const availableWidth = Math.max(1, width - padding * 2);
    const leftPadding = ' '.repeat(padding);
    const lines = [this.#header()];

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

    return lines.map((line) => leftPadding + truncateToWidth(line, availableWidth, '…'));
  }

  invalidate(): void {}

  #header(): string {
    if (!this.job) {
      const summary = this.#detailLines[0];
      return `${this.theme.fg('warning', '?')} ${this.theme.bold('Background Bash finished')}`
        + (summary ? this.theme.fg('muted', ` · ${summary}`) : '')
        + this.theme.fg('muted', ' · Alt+A details');
    }

    const metadata = [shortJobId(this.job.id)];
    if (!this.expanded && this.job.command) metadata.push(`$ ${inlineText(this.job.command)}`);
    metadata.push('Alt+A details');
    return `${statusIcon(this.job.status, this.theme)} ${this.theme.bold(statusTitle(this.job.status))}`
      + this.theme.fg('muted', ` · ${metadata.join(' · ')}`);
  }
}

function completionJob(details: CompletionMessageDetails | undefined): CompletionJobDetails | undefined {
  const job = details?.job;
  if (!isRecord(job)) return undefined;
  if (
    typeof job.id !== 'string'
    || !isTerminalStatus(job.status)
    || typeof job.command !== 'string'
    || (job.exitCode !== undefined && job.exitCode !== null && typeof job.exitCode !== 'number')
    || (job.signal !== undefined && job.signal !== null && typeof job.signal !== 'string')
    || (job.error !== undefined && typeof job.error !== 'string')
  ) return undefined;
  return job as unknown as CompletionJobDetails;
}

function jobDetailLines(job: CompletionJobDetails): string[] {
  const outcome = [
    inlineText(job.id),
    ...(job.exitCode === undefined || job.exitCode === null ? [] : [`exit ${job.exitCode}`]),
    ...(job.signal ? [`signal ${inlineText(job.signal)}`] : []),
    ...(job.error ? [inlineText(job.error)] : []),
  ].join(' · ');
  return [
    `$ ${inlineText(job.command)}`,
    outcome,
    `Use read_background_bash with id "${inlineText(job.id)}" for output.`,
  ];
}

function statusIcon(status: TerminalStatus, theme: Theme): string {
  if (status === 'completed') return theme.fg('success', '✓');
  if (status === 'failed') return theme.fg('error', '✗');
  if (status === 'killed') return theme.fg('dim', '■');
  return theme.fg('warning', '?');
}

function statusTitle(status: TerminalStatus): string {
  return status === 'unknown' ? 'Background Bash status unknown' : `Background Bash ${status}`;
}

function shortJobId(id: string): string {
  const normalized = inlineText(id);
  return normalized.match(/-([a-f0-9]{6})$/u)?.[1] ?? normalized.slice(0, 12);
}

function summaryLines(value: string): string[] {
  return stripTerminalSequences(value)
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => inlineText(line).replace(/^(?:#{1,6}|[-*+])\s+/u, ''))
    .filter(Boolean);
}

function inlineText(value: string): string {
  const normalized = stripTerminalSequences(value)
    .replace(INLINE_CONTROL_CHARACTERS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.length <= MAX_INLINE_CHARACTERS
    ? normalized
    : `${normalized.slice(0, MAX_INLINE_CHARACTERS - 1)}…`;
}

function messageText(content: string | readonly { type: string; text?: string }[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((entry) => entry.type === 'text' && typeof entry.text === 'string')
    .map((entry) => entry.text!)
    .join('\n');
}

function isTerminalStatus(value: unknown): value is TerminalStatus {
  return value === 'completed'
    || value === 'failed'
    || value === 'killed'
    || value === 'unknown';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
