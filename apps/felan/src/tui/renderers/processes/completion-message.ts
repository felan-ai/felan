import type { ExtensionContext } from '@felan-ai/agent-core';
import {
  truncateToWidth,
  type Component,
} from '@earendil-works/pi-tui';
import type { BackgroundBashStatus } from '@felan-ai/ext-background-bash/data';

import { MAX_DETAIL_LINES, summaryLines, inlineText, isRecord } from '../../completion-text.js';

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
          `  … ${this.#detailLines.length - MAX_DETAIL_LINES} more lines · /processes full details`,
        ));
      }
    }

    return lines.map((line) => leftPadding + truncateToWidth(line, availableWidth, '…'));
  }

  invalidate(): void {}

  #header(): string {
    if (!this.job) {
      const summary = this.#detailLines[0];
      return `${this.theme.fg('warning', '?')} ${this.theme.bold('Background process finished')}`
        + (summary ? this.theme.fg('muted', ` · ${summary}`) : '')
        + this.theme.fg('muted', ' · /processes details');
    }

    const metadata = [shortJobId(this.job.id)];
    if (!this.expanded && this.job.command) metadata.push(`$ ${inlineText(this.job.command)}`);
    metadata.push('/processes details');
    return `${statusIcon(this.job.status, this.theme)} ${this.theme.bold(statusTitle(this.job.status))}`
      + this.theme.fg('muted', ` · ${metadata.join(' · ')}`);
  }
}

export function completionJob(details: unknown): CompletionJobDetails | undefined {
  const job = isRecord(details) ? details.job : undefined;
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
  return status === 'unknown' ? 'Background process status unknown' : `Background process ${status}`;
}

function shortJobId(id: string): string {
  const normalized = inlineText(id);
  return normalized.match(/-([a-f0-9]{6})$/u)?.[1] ?? normalized.slice(0, 12);
}

function isTerminalStatus(value: unknown): value is TerminalStatus {
  return value === 'completed'
    || value === 'failed'
    || value === 'killed'
    || value === 'unknown';
}
