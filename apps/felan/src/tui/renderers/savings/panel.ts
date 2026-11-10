import { Key, Markdown, matchesKey, stripTerminalSequences, truncateToWidth, type Component, type TuiMouseEvent, type TuiMouseEventResult } from '@earendil-works/pi-tui';
import type { Theme, UiActionRequest, UiDocument } from '@felan-ai/agent-core';
import { decodeUiMarkdown } from '../../../client/ui.js';
import {
  SAVINGS_ACTIONS, SAVINGS_RANGES, SAVINGS_TABS, formatSavingsTokenImpact, formatSavingsTokens, formatSavingsUsd, savingsCategoryLabel,
  type SavingsAmount, type SavingsDashboard, type SavingsRangeId, type SavingsRangeView, type SavingsShare, type SavingsTabId,
} from '../../../savings/data.js';
import { clientMarkdownTheme } from '../../theme.js';
import { bar, sparkline } from '../insights/charts.js';

export interface SavingsPanelState {
  tab: SavingsTabId;
  range: SavingsRangeId;
  scroll: Partial<Record<SavingsTabId, number>>;
  /** Selected row on the Sessions tab, as a position in the current range. */
  selected: number;
  /** Session catalogue index whose breakdown replaces the Sessions table. */
  detail?: number | undefined;
}

export type SavingsOutcome = UiActionRequest | undefined;

const TAB_LABELS: Record<SavingsTabId, string> = { overview: 'Overview', extensions: 'Extensions', sessions: 'Sessions', projects: 'Projects' };
const RANGE_LABELS: Record<SavingsRangeId, string> = { session: 'This session', '7d': '7 days', '30d': '30 days', '90d': '90 days', all: 'All time' };
const SESSION_TABLE_OFFSET = 3;
const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

const clean = (value: string) => stripTerminalSequences(value).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, '');
const clip = (value: string, width: number) => (value.length > width ? `${value.slice(0, Math.max(0, width - 1))}…` : value);
const cell = (value: string, width: number) => clip(clean(value), width).padEnd(width);
const count = (value: number) => integer.format(value);
const counted = (value: number, noun: string) => `${count(value)} ${noun}${value === 1 ? '' : 's'}`;

export class SavingsPanel implements Component {
  private closed = false;
  private maximum = 0;
  private readonly markdown: Markdown;
  private readonly bodies = new Map<string, string[]>();

  constructor(
    private readonly element: UiDocument,
    private readonly dashboard: SavingsDashboard | undefined,
    private readonly state: SavingsPanelState,
    private readonly theme: Theme,
    private readonly terminalRows: () => number,
    private readonly requestRender: () => void,
    private readonly done: (outcome: SavingsOutcome) => void,
  ) {
    this.markdown = new Markdown(clean(decodeUiMarkdown(element.markdown)), 1, 0, clientMarkdownTheme(() => theme));
  }

  invalidate(): void { this.markdown.invalidate(); this.bodies.clear(); }

  render(width: number): string[] {
    const w = Math.max(1, Math.floor(width));
    const dashboard = this.dashboard;
    const header = dashboard ? this.header(dashboard) : [this.theme.fg('accent', this.theme.bold(clean(this.element.title))), ''];
    const body = dashboard ? this.cachedBody(dashboard, w) : this.markdown.render(w);
    const footer = [this.theme.fg('dim', this.hints())];
    const viewport = Math.max(1, this.terminalRows() - header.length - footer.length);
    this.maximum = Math.max(0, body.length - viewport);
    let scroll = Math.min(this.current(), this.maximum);
    if (dashboard && this.state.tab === 'sessions' && this.state.detail === undefined) {
      const row = SESSION_TABLE_OFFSET + this.state.selected;
      scroll = Math.min(this.maximum, Math.max(scroll, row - viewport + 1, 0), row);
    }
    this.state.scroll[this.state.tab] = scroll;
    const visible = body.slice(scroll, scroll + viewport);
    return [...header, ...visible, ...Array<string>(viewport - visible.length).fill(''), ...footer].map(line => truncateToWidth(line, w));
  }

  handleInput(data: string): void {
    if (this.closed) return;
    if (matchesKey(data, Key.escape) || data === 'q') this.back();
    else if (!(this.selecting() && this.selectionKey(data))) this.navigationKey(data);
    if (!this.closed) this.requestRender();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.closed || event.type !== 'wheel') return undefined;
    const delta = Math.sign(event.wheelDelta ?? 0) * 3;
    if (this.selecting()) this.moveSelection(delta); else this.scrollBy(delta);
    this.requestRender();
    return { handled: true };
  }

  private back(): void {
    if (this.state.detail !== undefined) this.state.detail = undefined;
    else if (this.hasAction(SAVINGS_ACTIONS.close)) this.submit(SAVINGS_ACTIONS.close);
    else this.dismiss();
  }

  private navigationKey(data: string): void {
    if (matchesKey(data, Key.up)) this.scrollBy(-1);
    else if (matchesKey(data, Key.down)) this.scrollBy(1);
    else if (matchesKey(data, Key.pageUp)) this.scrollBy(-this.pageSize());
    else if (matchesKey(data, Key.pageDown)) this.scrollBy(this.pageSize());
    else if (matchesKey(data, Key.home)) this.setScroll(0);
    else if (matchesKey(data, Key.end)) this.setScroll(this.maximum);
    else if (matchesKey(data, Key.tab)) this.selectTab((SAVINGS_TABS.indexOf(this.state.tab) + 1) % SAVINGS_TABS.length);
    else if (/^[1-4]$/u.test(data)) this.selectTab(Number(data) - 1);
    else if (data === 'r' && this.dashboard) this.selectRange(1);
    else if (data === 'R') this.submit(SAVINGS_ACTIONS.refresh);
  }

  /** The Sessions table moves a row selection instead of scrolling, so Enter can open that row. */
  private selecting(): boolean {
    return this.dashboard !== undefined && this.state.tab === 'sessions' && this.state.detail === undefined;
  }

  private selectionKey(data: string): boolean {
    const rows = this.view(this.dashboard!).sessions;
    if (matchesKey(data, Key.up)) this.moveSelection(-1);
    else if (matchesKey(data, Key.down)) this.moveSelection(1);
    else if (matchesKey(data, Key.pageUp)) this.moveSelection(-this.pageSize());
    else if (matchesKey(data, Key.pageDown)) this.moveSelection(this.pageSize());
    else if (matchesKey(data, Key.home)) this.moveSelection(-rows.length);
    else if (matchesKey(data, Key.end)) this.moveSelection(rows.length);
    else if (matchesKey(data, Key.enter) && rows[this.state.selected]) this.state.detail = rows[this.state.selected]!.session;
    else return false;
    return true;
  }

  private moveSelection(delta: number): void {
    const rows = this.view(this.dashboard!).sessions;
    this.state.selected = Math.max(0, Math.min(rows.length - 1, this.state.selected + delta));
  }

  private hasAction(id: string): boolean {
    return this.element.actions.some(action => action.id === id && action.target === 'element');
  }

  private submit(actionId: string): void {
    const action = this.element.actions.find(candidate => candidate.id === actionId && candidate.target === 'element');
    if (!action || this.closed) return;
    this.closed = true;
    this.done({ elementId: this.element.id, revision: this.element.revision, actionId, outcome: action.outcome, values: {} });
  }

  private dismiss(): void {
    if (this.closed) return;
    this.closed = true;
    this.done(undefined);
  }

  private selectTab(index: number): void {
    this.state.tab = SAVINGS_TABS[index] ?? this.state.tab;
    this.state.detail = undefined;
  }

  private selectRange(step: number): void {
    this.state.range = SAVINGS_RANGES[(SAVINGS_RANGES.indexOf(this.state.range) + step + SAVINGS_RANGES.length) % SAVINGS_RANGES.length]!;
    this.state.scroll = {};
    this.state.selected = 0;
    this.state.detail = undefined;
  }

  private current(): number { return this.state.scroll[this.state.tab] ?? 0; }
  private scrollBy(delta: number): void { this.setScroll(this.current() + delta); }
  private setScroll(value: number): void { this.state.scroll[this.state.tab] = Math.max(0, Math.min(this.maximum, value)); }
  private pageSize(): number { return Math.max(1, this.terminalRows() - 9); }

  private hints(): string {
    if (!this.dashboard) return 'Esc close · ↑↓ PgUp/PgDn scroll';
    if (this.state.detail !== undefined) return 'Esc back · ↑↓ scroll';
    const rows = this.state.tab === 'sessions' ? '↑↓ select · Enter details' : '↑↓ PgUp/PgDn scroll';
    return `Tab/1-4 tabs · r range · ${rows} · ${this.hasAction(SAVINGS_ACTIONS.refresh) ? 'R refresh · ' : ''}Esc close`;
  }

  private view(d: SavingsDashboard): SavingsRangeView {
    return d.ranges.find(range => range.id === this.state.range) ?? d.ranges[0]!;
  }

  private header(d: SavingsDashboard): string[] {
    const view = this.view(d);
    const title = `${this.theme.fg('accent', this.theme.bold('Felan Code Savings'))}  ${clean(view.label)} · ${this.usd(view.totals.savedUsd, 0)} saved · ${counted(view.totals.decisions, 'decision')} · ${counted(view.sessions.length + view.omittedSessions, 'session')}`;
    const tabs = SAVINGS_TABS.map((tab, index) => tab === this.state.tab
      ? this.theme.fg('accent', this.theme.bold(`[${index + 1} ${TAB_LABELS[tab]}]`))
      : this.theme.fg('muted', `${index + 1} ${TAB_LABELS[tab]}`)).join('  ');
    const ranges = SAVINGS_RANGES.map(range => range === this.state.range
      ? this.theme.fg('accent', this.theme.bold(`[${RANGE_LABELS[range]}]`)) : this.theme.fg('muted', RANGE_LABELS[range])).join(' · ');
    return [title, tabs, `${this.theme.fg('muted', 'Range')} ${ranges}`, ''];
  }

  private cachedBody(d: SavingsDashboard, width: number): string[] {
    const { tab, range, selected, detail } = this.state;
    const key = `${tab}|${range}|${width}|${this.element.revision}|${tab === 'sessions' ? `${selected}|${detail ?? ''}` : ''}`;
    let body = this.bodies.get(key);
    if (!body) { body = this.tabBody(d, width); this.bodies.set(key, body); }
    return body;
  }

  private tabBody(d: SavingsDashboard, width: number): string[] {
    switch (this.state.tab) {
      case 'overview': return this.overview(d, width);
      case 'extensions': return this.extensions(d, width);
      case 'sessions': return this.state.detail === undefined ? this.sessions(d, width) : this.sessionDetail(d, this.state.detail, width);
      case 'projects': return this.projects(d, width);
    }
  }

  private overview(d: SavingsDashboard, width: number): string[] {
    const view = this.view(d);
    const t = view.totals;
    const project = d.currentProject === undefined ? 'This project' : `This project (${clean(d.projects[d.currentProject]!.label)})`;
    const lines = [
      `Saved ${this.usd(t.savedUsd, 0)}   Baseline ${formatSavingsUsd(t.baselineUsd)}   Actual ${formatSavingsUsd(t.actualUsd)}   Decisions ${count(t.decisions)}   ${this.tokenImpact(t.savedTokens)}`,
      `This session ${this.usd(view.currentSession.savedUsd, 0)} · ${counted(view.currentSession.decisions, 'decision')}   ${project} ${this.usd(view.currentProject.savedUsd, 0)} · ${counted(view.currentProject.decisions, 'decision')}`,
    ];
    if (view.unpriced.decisions) lines.push(this.theme.fg('warning', `${counted(view.unpriced.decisions, 'decision')} without a price are excluded from USD totals (${formatSavingsTokenImpact(view.unpriced.savedTokens)}).`));
    lines.push('', this.heading('By category'));
    if (!view.categories.length) lines.push(this.muted('No measured savings in this range.'));
    lines.push(...this.bars(view.categories.map(row => ({ name: savingsCategoryLabel(row.category), amount: row })), width));
    const points = view.trend.points;
    lines.push('', this.heading(`Savings per ${view.trend.granularity}`));
    lines.push(this.theme.fg('accent', sparkline(points.map(point => Math.max(0, point.savedUsd)), Math.max(8, width - 2))));
    const peak = points.reduce((best, point) => point.savedUsd > best.savedUsd ? point : best, points[0]!);
    lines.push(this.muted(`${points[0]!.period} → ${points.at(-1)!.period} · peak ${formatSavingsUsd(peak.savedUsd)} on ${peak.period}`));
    lines.push('', this.heading('By extension'));
    if (!view.extensions.length) lines.push(this.muted('No measured savings in this range.'));
    lines.push(...this.bars(view.extensions.map(row => ({ name: d.extensions[row.extension]!.label, amount: row })), width));
    lines.push('', this.muted('API-equivalent estimates priced from the model catalog when each decision was measured. Days are UTC.'));
    if (d.firstDay) lines.push(this.muted(`Measurements retained since ${d.firstDay}.`));
    lines.push(...d.diagnostics.map(diagnostic => this.theme.fg('warning', `Warning: ${clean(diagnostic)}`)));
    return lines;
  }

  private extensions(d: SavingsDashboard, width: number): string[] {
    const view = this.view(d);
    if (!view.extensions.length) return [this.muted('No measured savings in this range.')];
    const nameWidth = Math.max(12, Math.min(28, width - 56));
    const lines = [this.heading(`${'Extension'.padEnd(nameWidth)} ${'Category'.padEnd(20)} ${'Decisions'.padStart(10)} ${'Tokens saved'.padStart(12)} ${'Saved'.padStart(12)}`)];
    for (const row of view.extensions) {
      const extension = d.extensions[row.extension]!;
      lines.push(`${cell(extension.label, nameWidth)} ${savingsCategoryLabel(extension.category).padEnd(20)} ${count(row.decisions).padStart(10)} ${this.tokens(row.savedTokens, 12)} ${this.usd(row.savedUsd, 12)}`);
      for (const operation of row.operations) {
        const label = `  ${operation.operation} · ${operation.basis === 'observed-comparison' ? 'observed' : 'estimated'} · ${operation.method}`;
        lines.push(this.muted(`${cell(label, nameWidth + 21)} ${count(operation.decisions).padStart(10)} ${formatSavingsTokens(operation.savedTokens).padStart(12)} ${formatSavingsUsd(operation.savedUsd).padStart(12)}`));
      }
    }
    lines.push('', this.muted('Observed savings compare real outcomes; estimated savings compare against a modelled baseline. Negative tokens saved mean the optimization used more tokens to reach a cheaper result.'));
    if (view.unpriced.decisions) lines.push(this.muted(`${counted(view.unpriced.decisions, 'decision')} without a price are not included above.`));
    return lines;
  }

  private sessions(d: SavingsDashboard, width: number): string[] {
    const view = this.view(d);
    const rows = view.sessions;
    const projectWidth = Math.max(8, Math.min(20, Math.floor(width / 6)));
    const titleWidth = Math.max(12, width - projectWidth - 46);
    const lines = [
      this.muted(`${counted(rows.length + view.omittedSessions, 'session')} with savings · ● this session`),
      '',
      this.heading(`   ${'Session'.padEnd(titleWidth)} ${'Project'.padEnd(projectWidth)} ${'Last day'.padEnd(10)} ${'Decisions'.padStart(9)} ${'Saved'.padStart(11)}`),
    ];
    if (!rows.length) lines.push(this.muted('  No sessions with savings in this range.'));
    rows.forEach((row, position) => {
      const session = d.sessions[row.session]!;
      const marker = row.session === d.currentSession ? '●' : ' ';
      const selected = position === this.state.selected;
      const line = `${selected ? '›' : ' '}${marker} ${cell(session.title, titleWidth)} ${cell(d.projects[session.project]!.label, projectWidth)} ${session.lastDay} ${count(row.decisions).padStart(9)} `;
      lines.push(selected ? this.theme.fg('accent', `${line}${formatSavingsUsd(row.savedUsd).padStart(11)}`) : `${line}${this.usd(row.savedUsd, 11)}`);
    });
    if (view.omittedSessions) lines.push('', this.muted(`${counted(view.omittedSessions, 'smaller session')} not listed.`));
    return lines;
  }

  private sessionDetail(d: SavingsDashboard, index: number, width: number): string[] {
    const session = d.sessions[index]!;
    const total = session.extensions.reduce<SavingsShare>((sum, row) => ({
      savedUsd: sum.savedUsd + row.savedUsd, decisions: sum.decisions + row.decisions, savedTokens: sum.savedTokens + row.savedTokens,
    }), { savedUsd: 0, decisions: 0, savedTokens: 0 });
    const nameWidth = Math.max(12, Math.min(28, width - 40));
    return [
      this.heading(clean(session.title)),
      this.muted(`${clean(d.projects[session.project]!.label)} · last measured ${session.lastDay} · ${clean(session.id)}`),
      '',
      `All-time savings ${this.usd(total.savedUsd, 0)} · ${counted(total.decisions, 'decision')} · ${this.tokenImpact(total.savedTokens)}`,
      '',
      this.heading(`${'Extension'.padEnd(nameWidth)} ${'Decisions'.padStart(10)} ${'Tokens saved'.padStart(12)} ${'Saved'.padStart(12)}`),
      ...(session.extensions.length ? session.extensions.map(row => `${cell(d.extensions[row.extension]!.label, nameWidth)} ${count(row.decisions).padStart(10)} ${this.tokens(row.savedTokens, 12)} ${this.usd(row.savedUsd, 12)}`)
        : [this.muted('No measured savings for this session yet.')]),
    ];
  }

  private projects(d: SavingsDashboard, width: number): string[] {
    const view = this.view(d);
    if (!view.projects.length) return [this.muted('No projects with savings in this range.')];
    const nameWidth = Math.max(10, Math.min(28, Math.floor(width / 4)));
    const barWidth = Math.max(4, width - nameWidth - 40);
    const maximum = Math.max(0, ...view.projects.map(row => row.savedUsd));
    return [
      this.heading(`${'Project'.padEnd(nameWidth + 2)} ${''.padEnd(barWidth)} ${'Saved'.padStart(11)} ${'Sessions'.padStart(9)} ${'Decisions'.padStart(10)}`),
      ...view.projects.map(row => {
        const marker = row.project === d.currentProject ? '●' : ' ';
        return `${cell(d.projects[row.project]!.label, nameWidth)} ${marker} ${this.theme.fg('accent', bar(row.savedUsd, maximum, barWidth))} ${this.usd(row.savedUsd, 11)} ${count(row.sessions).padStart(9)} ${count(row.decisions).padStart(10)}`;
      }),
    ];
  }

  private bars(rows: ReadonlyArray<{ name: string; amount: SavingsAmount }>, width: number): string[] {
    const nameWidth = Math.max(10, Math.min(24, Math.max(0, ...rows.map(row => row.name.length))));
    const barWidth = Math.max(4, width - nameWidth - 34);
    const maximum = Math.max(0, ...rows.map(row => row.amount.savedUsd));
    return rows.map(row => `${cell(row.name, nameWidth)} ${this.theme.fg('accent', bar(row.amount.savedUsd, maximum, barWidth))} ${this.usd(row.amount.savedUsd, 11)} ${counted(row.amount.decisions, 'decision').padStart(15)}`);
  }

  /** Pads before coloring so added cost keeps its column alignment. */
  private usd(value: number, width: number): string {
    const text = formatSavingsUsd(value).padStart(width);
    return value < 0 ? this.theme.fg('warning', text) : text;
  }

  private tokenImpact(value: number): string {
    const text = formatSavingsTokenImpact(value);
    return value < 0 ? this.theme.fg('warning', text) : text;
  }

  private tokens(value: number, width: number): string {
    const text = formatSavingsTokens(value).padStart(width);
    return value < 0 ? this.theme.fg('warning', text) : text;
  }
  private heading(text: string): string { return this.theme.fg('accent', this.theme.bold(text)); }
  private muted(text: string): string { return this.theme.fg('muted', text); }
}
