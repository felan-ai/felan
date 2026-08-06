import type { ExtensionContext } from '@felan-ai/agent-core';
import { matchesKey, truncateToWidth } from '@earendil-works/pi-tui';
import type { BackgroundBashJob } from '../job-store.js';
import type { BackgroundBashManager } from '../process-manager.js';

const LOG_SCROLLBACK_LINES = 2_000;
const LOG_VISIBLE_LINES = 28;
const JOB_LIST_VISIBLE_ROWS = 18;
const PADDING_X = 2;
const PADDING_Y = 1;

type Theme = ExtensionContext['ui']['theme'];
type OverlayView = 'list' | 'detail';

export class BackgroundBashOverlay {
  private jobs: BackgroundBashJob[] = [];
  private selected = 0;
  private listScroll = 0;
  private logLines: string[] = [];
  private logScroll = 0;
  private loading = false;
  private message = '';
  private view: OverlayView = 'list';

  constructor(
    private readonly manager: BackgroundBashManager,
    private readonly theme: Theme,
    private readonly done: () => void,
    private readonly requestRender: () => void,
  ) {
    void this.refresh();
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape') || data === 'q') {
      this.done();
      return;
    }

    if (this.view === 'list') {
      this.handleListInput(data);
      return;
    }
    this.handleDetailInput(data);
  }

  render(width: number): string[] {
    const lines = this.view === 'list' ? this.renderList() : this.renderDetail();
    const innerWidth = Math.max(1, width - PADDING_X * 2);
    const prefix = ' '.repeat(PADDING_X);
    const padded = lines.map((line) => `${prefix}${truncateToWidth(line, innerWidth, '…')}${prefix}`);
    return [...Array<string>(PADDING_Y).fill(''), ...padded, ...Array<string>(PADDING_Y).fill('')];
  }

  invalidate(): void {}

  private handleListInput(data: string): void {
    if (matchesKey(data, 'up')) {
      this.selectListJob(-1);
      return;
    }
    if (matchesKey(data, 'down')) {
      this.selectListJob(1);
      return;
    }
    if (matchesKey(data, 'ctrl+u')) {
      this.selectListJob(-JOB_LIST_VISIBLE_ROWS);
      return;
    }
    if (matchesKey(data, 'ctrl+d')) {
      this.selectListJob(JOB_LIST_VISIBLE_ROWS);
      return;
    }
    if (matchesKey(data, 'home') || data === 'g') {
      this.selected = 0;
      this.clampListScroll();
      this.requestRender();
      return;
    }
    if (matchesKey(data, 'end') || data === 'G') {
      this.selected = Math.max(0, this.jobs.length - 1);
      this.clampListScroll();
      this.requestRender();
      return;
    }
    if (matchesKey(data, 'return') || matchesKey(data, 'right')) {
      void this.openDetail();
      return;
    }
    if (data === 'r') {
      void this.refresh();
      return;
    }
    if (data === 's') {
      void this.stopSelected();
      return;
    }
    if (data === 'k') void this.killSelected();
  }

  private handleDetailInput(data: string): void {
    if (matchesKey(data, 'backspace') || matchesKey(data, 'left')) {
      this.view = 'list';
      this.requestRender();
      return;
    }
    if (matchesKey(data, 'up')) {
      this.scrollLog(-1);
      return;
    }
    if (matchesKey(data, 'down')) {
      this.scrollLog(1);
      return;
    }
    if (matchesKey(data, 'ctrl+u')) {
      this.scrollLog(-LOG_VISIBLE_LINES);
      return;
    }
    if (matchesKey(data, 'ctrl+d')) {
      this.scrollLog(LOG_VISIBLE_LINES);
      return;
    }
    if (matchesKey(data, 'home') || data === 'g') {
      this.logScroll = 0;
      this.requestRender();
      return;
    }
    if (matchesKey(data, 'end') || data === 'G') {
      this.scrollLogToBottom();
      this.requestRender();
      return;
    }
    if (data === 'r') {
      void this.refreshDetail();
      return;
    }
    if (data === 's') {
      void this.stopSelected();
      return;
    }
    if (data === 'k') void this.killSelected();
  }

  private renderList(): string[] {
    const lines: string[] = [];
    const runningCount = this.jobs.filter((job) => job.status.status === 'running').length;
    const runningLabel = runningCount === 1 ? '1 running' : `${runningCount} running`;

    lines.push(
      this.theme.fg('accent', this.theme.bold('Background Bash'))
      + '  '
      + (runningCount > 0
        ? this.theme.fg('accent', runningLabel)
        : this.theme.fg('dim', runningLabel))
      + this.theme.fg('dim', '  ↑↓ select • enter/→ open • s stop • k kill • r refresh • q/esc close'),
    );
    if (this.loading) lines.push(this.theme.fg('warning', 'Refreshing...'));
    if (this.message) lines.push(this.theme.fg('muted', this.message));
    lines.push('');

    if (this.jobs.length === 0) {
      lines.push(this.theme.fg('dim', 'No Background Bash processes found for this workspace.'));
      return lines;
    }

    const start = this.listScroll;
    const end = Math.min(this.jobs.length, start + JOB_LIST_VISIBLE_ROWS);
    lines.push(this.theme.fg('dim', `Showing processes ${start + 1}-${end}/${this.jobs.length}`));
    for (let index = start; index < end; index += 1) {
      const job = this.jobs[index]!;
      const marker = index === this.selected ? this.theme.fg('accent', '▶') : ' ';
      lines.push(
        `${marker} ${job.meta.id}  ${colorStatus(job, this.theme)}  ${formatDuration(job)}  ${oneLine(job.meta.command, 90)}`,
      );
    }
    return lines;
  }

  private renderDetail(): string[] {
    const lines: string[] = [];
    const current = this.jobs[this.selected];
    if (!current) return [this.theme.fg('dim', 'No process selected.')];

    lines.push(
      this.theme.fg('accent', this.theme.bold(current.meta.id))
      + this.theme.fg('dim', '  backspace/← processes • ↑↓ scroll • ctrl+u/d page • g/G top/bottom • r refresh • s stop • k kill • q/esc close'),
    );
    if (this.loading) lines.push(this.theme.fg('warning', 'Refreshing...'));
    if (this.message) lines.push(this.theme.fg('muted', this.message));
    lines.push('');
    lines.push(`status=${colorStatus(current, this.theme)}  duration=${formatDuration(current)}`);
    lines.push(`command=${current.meta.command}`);
    lines.push('');

    const totalLines = this.logLines.length;
    const start = Math.min(this.logScroll, Math.max(0, totalLines - 1));
    const end = Math.min(totalLines, start + LOG_VISIBLE_LINES);
    const range = totalLines === 0 ? '0/0' : `${start + 1}-${end}/${totalLines}`;
    lines.push(this.theme.fg('accent', this.theme.bold('Log')) + this.theme.fg('dim', `  ${range}`));
    const visible = this.logLines.slice(start, end);
    for (const line of visible.length > 0 ? visible : ['(log is empty)']) {
      lines.push(this.theme.fg('toolOutput', line));
    }
    return lines;
  }

  private async refresh(): Promise<void> {
    this.loading = true;
    this.requestRender();
    try {
      const selectedId = this.jobs[this.selected]?.meta.id;
      this.jobs = await this.manager.list('all');
      const selectedIndex = selectedId
        ? this.jobs.findIndex((job) => job.meta.id === selectedId)
        : -1;
      this.selected = selectedIndex >= 0
        ? selectedIndex
        : Math.min(this.selected, Math.max(0, this.jobs.length - 1));
      this.clampListScroll();
      if (this.view === 'detail') await this.refreshLog(false, true);
      this.message = `Last refresh: ${new Date().toLocaleTimeString()}`;
    } catch (error) {
      this.message = errorMessage(error);
    } finally {
      this.loading = false;
      this.requestRender();
    }
  }

  private async refreshDetail(): Promise<void> {
    await this.refresh();
    await this.refreshLog(true, true);
  }

  private async refreshLog(render = true, scrollToBottom = false): Promise<void> {
    const current = this.jobs[this.selected];
    if (!current) {
      this.logLines = [];
      this.logScroll = 0;
      if (render) this.requestRender();
      return;
    }

    try {
      const log = await this.manager.tail(current.meta.id, LOG_SCROLLBACK_LINES);
      this.logLines = getProcessOutputLines(log);
    } catch (error) {
      this.logLines = [errorMessage(error)];
    }
    if (scrollToBottom) this.scrollLogToBottom();
    else this.clampLogScroll();
    if (render) this.requestRender();
  }

  private selectListJob(delta: number): void {
    if (this.jobs.length === 0) return;
    this.selected = Math.max(0, Math.min(this.jobs.length - 1, this.selected + delta));
    this.clampListScroll();
    this.requestRender();
  }

  private async openDetail(): Promise<void> {
    if (this.jobs.length === 0) return;
    this.view = 'detail';
    await this.refreshLog(true, true);
  }

  private clampListScroll(): void {
    if (this.selected < this.listScroll) this.listScroll = this.selected;
    if (this.selected >= this.listScroll + JOB_LIST_VISIBLE_ROWS) {
      this.listScroll = this.selected - JOB_LIST_VISIBLE_ROWS + 1;
    }
    this.listScroll = Math.max(
      0,
      Math.min(this.listScroll, Math.max(0, this.jobs.length - JOB_LIST_VISIBLE_ROWS)),
    );
  }

  private scrollLog(delta: number): void {
    this.logScroll += delta;
    this.clampLogScroll();
    this.requestRender();
  }

  private scrollLogToBottom(): void {
    this.logScroll = Math.max(0, this.logLines.length - LOG_VISIBLE_LINES);
  }

  private clampLogScroll(): void {
    this.logScroll = Math.max(
      0,
      Math.min(this.logScroll, Math.max(0, this.logLines.length - LOG_VISIBLE_LINES)),
    );
  }

  private async stopSelected(): Promise<void> {
    await this.signalSelected('SIGTERM', 'Stopping', 'Stopped');
  }

  private async killSelected(): Promise<void> {
    await this.signalSelected('SIGKILL', 'Killing', 'Killed');
  }

  private async signalSelected(
    signal: 'SIGTERM' | 'SIGKILL',
    action: string,
    result: string,
  ): Promise<void> {
    const current = this.jobs[this.selected];
    if (!current) return;
    this.loading = true;
    this.message = `${action} ${current.meta.id}...`;
    this.requestRender();
    try {
      await this.manager.stop(current.meta.id, signal);
      await this.refresh();
      if (this.view === 'detail') await this.refreshLog(false, true);
      this.message = `${result} ${current.meta.id}`;
    } catch (error) {
      this.message = errorMessage(error);
    } finally {
      this.loading = false;
      this.requestRender();
    }
  }
}

function getProcessOutputLines(log: string): string[] {
  const lines = log.split(/\r?\n/);
  const outputMarkerIndex = lines.findIndex((line) => line.trim() === '--- output ---');
  const source = outputMarkerIndex >= 0 ? lines.slice(outputMarkerIndex + 1) : lines;
  const result: string[] = [];

  for (let index = 0; index < source.length; index += 1) {
    const line = source[index] ?? '';
    const trimmed = line.trim();
    if (trimmed === '--- spawned ---') {
      if ((source[index + 1] ?? '').startsWith('pid: ')) index += 1;
      continue;
    }
    if (/^--- (completed|failed|killed|unknown) ---$/u.test(trimmed)) {
      while (/^(status|exitCode|signal|completed|error):/u.test(source[index + 1] ?? '')) index += 1;
      continue;
    }
    result.push(line);
  }

  while (result[0]?.trim() === '') result.shift();
  while (result.at(-1)?.trim() === '') result.pop();
  return result.length > 0 ? result : ['(no process output yet)'];
}

function colorStatus(job: BackgroundBashJob, theme: Theme): string {
  const color = job.status.status === 'running'
    ? 'accent'
    : job.status.status === 'completed'
      ? 'success'
      : job.status.status === 'failed'
        ? 'error'
        : 'warning';
  return theme.fg(color, job.status.status);
}

function oneLine(value: string, max: number): string {
  const compact = value.replace(/\s+/gu, ' ').trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

function formatDuration(job: BackgroundBashJob): string {
  const end = job.status.completedAt ?? Date.now();
  const seconds = Math.max(0, Math.round((end - job.meta.startedAt) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${seconds % 60}s`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
