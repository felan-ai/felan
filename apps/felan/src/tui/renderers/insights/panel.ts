import { Key, Markdown, matchesKey, stripTerminalSequences, truncateToWidth, type Component, type MarkdownTheme, type TuiMouseEvent, type TuiMouseEventResult } from '@earendil-works/pi-tui';
import type { Theme, ThemeColor, UiActionRequest, UiDocument, UiValues } from '@felan-ai/agent-core';
import { INSIGHTS_ACTIONS, type InsightsDashboard } from '@felan-ai/ext-insights/data';
import { decodeUiMarkdown } from '../../../client/ui.js';
import { bar, formatCount, formatMinutes, formatMoney, formatPercent, heatLevel, hourLabels, shade, sparkline } from './charts.js';

export const TABS = ['overview', 'models', 'projects', 'sessions', 'rage'] as const;
export type InsightsTab = typeof TABS[number];
type Metric = 'sessions' | 'tokens' | 'cost';
type ProjectSort = 'messages' | 'sessions' | 'tokens' | 'cost';

export interface InsightsPanelState {
  tab: InsightsTab;
  scroll: Partial<Record<InsightsTab, number>>;
  metric: Metric;
  sort: ProjectSort;
}

export type InsightsOutcome = UiActionRequest | 'search' | undefined;

const TAB_LABELS: Record<InsightsTab, string> = { overview: 'Overview', models: 'Models', projects: 'Projects', sessions: 'Sessions', rage: 'Rage' };
const METRIC_LABELS: Record<Metric, string> = { sessions: 'sessions', tokens: 'tokens', cost: 'cost' };
const METRICS: Metric[] = ['sessions', 'tokens', 'cost'];
const SORTS: ProjectSort[] = ['messages', 'sessions', 'tokens', 'cost'];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAY_MS = 24 * 60 * 60 * 1000;

const clean = (value: string) => stripTerminalSequences(value).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, '');
const clip = (value: string, width: number) => (value.length > width ? `${value.slice(0, Math.max(0, width - 1))}…` : value);
const pad2 = (value: number) => String(value).padStart(2, '0');

function markdownThemeFor(theme: Theme): MarkdownTheme {
  const color = (name: ThemeColor) => (text: string) => theme.fg(name, text);
  return {
    heading: color('accent'), link: color('accent'), linkUrl: color('dim'), code: color('success'), codeBlock: color('text'),
    codeBlockBorder: color('border'), quote: color('muted'), quoteBorder: color('border'), hr: color('border'), listBullet: color('accent'),
    bold: text => theme.bold(text), italic: text => theme.italic(text), strikethrough: text => theme.strikethrough(text), underline: text => theme.underline(text),
  };
}

function startLabel(iso: string): string {
  const date = new Date(iso);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

export class InsightsPanel implements Component {
  private closed = false;
  private maximum = 0;
  private readonly markdown: Markdown;

  constructor(
    private readonly element: UiDocument,
    private readonly dashboard: InsightsDashboard | undefined,
    private readonly state: InsightsPanelState,
    private readonly theme: Theme,
    private readonly terminalRows: () => number,
    private readonly requestRender: () => void,
    private readonly done: (outcome: InsightsOutcome) => void,
  ) {
    this.markdown = new Markdown(clean(decodeUiMarkdown(element.markdown)), 1, 0, markdownThemeFor(theme));
  }

  invalidate(): void { this.markdown.invalidate(); }

  render(width: number): string[] {
    const w = Math.max(1, Math.floor(width));
    const dashboard = this.dashboard;
    const header = dashboard ? this.header(dashboard) : [this.theme.fg('accent', this.theme.bold(clean(this.element.title))), ''];
    const body = dashboard ? this.tabBody(dashboard, w) : this.markdown.render(w);
    const footer = [this.theme.fg('dim', this.hints())];
    const viewport = Math.max(1, this.terminalRows() - header.length - footer.length - 1);
    this.maximum = Math.max(0, body.length - viewport);
    const scroll = Math.min(this.current(), this.maximum);
    this.state.scroll[this.state.tab] = scroll;
    return [...header, ...body.slice(scroll, scroll + viewport), ...footer].map(line => truncateToWidth(line, w));
  }

  handleInput(data: string): void {
    if (this.closed) return;
    if (matchesKey(data, Key.escape) || data === 'q') {
      if (this.hasAction('close')) this.submit('close'); else this.dismiss();
      return;
    }
    if (matchesKey(data, Key.up)) this.scrollBy(-1);
    else if (matchesKey(data, Key.down)) this.scrollBy(1);
    else if (matchesKey(data, Key.pageUp)) this.scrollBy(-this.pageSize());
    else if (matchesKey(data, Key.pageDown)) this.scrollBy(this.pageSize());
    else if (matchesKey(data, Key.home)) this.setScroll(0);
    else if (matchesKey(data, Key.end)) this.setScroll(this.maximum);
    else if (matchesKey(data, Key.tab)) this.selectTab((TABS.indexOf(this.state.tab) + 1) % TABS.length);
    else if (/^[1-5]$/u.test(data)) this.selectTab(Number(data) - 1);
    else if (this.dashboard) this.dashboardKey(data);
    if (!this.closed) this.requestRender();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.closed || event.type !== 'wheel') return undefined;
    this.scrollBy(Math.sign(event.wheelDelta ?? 0) * 3);
    this.requestRender();
    return { handled: true };
  }

  private dashboardKey(data: string): void {
    if (data === 'm' && this.state.tab === 'overview') this.state.metric = METRICS[(METRICS.indexOf(this.state.metric) + 1) % METRICS.length]!;
    else if (data === 's' && this.state.tab === 'projects') this.state.sort = SORTS[(SORTS.indexOf(this.state.sort) + 1) % SORTS.length]!;
    else if (data === 'r') this.cycleRange();
    else if (data === '/') this.search();
    else if (data === 'o') this.submit(INSIGHTS_ACTIONS.openBrowser);
    else if (this.state.tab === 'sessions' && matchesKey(data, Key.left)) this.submit(INSIGHTS_ACTIONS.previous);
    else if (this.state.tab === 'sessions' && matchesKey(data, Key.right)) this.submit(INSIGHTS_ACTIONS.next);
  }

  private hasAction(id: string): boolean {
    return this.element.actions.some(action => action.id === id && action.target === 'element');
  }

  private submit(actionId: string, values: UiValues = {}): void {
    const action = this.element.actions.find(candidate => candidate.id === actionId && candidate.target === 'element');
    if (!action || this.closed) return;
    this.closed = true;
    this.done({ elementId: this.element.id, revision: this.element.revision, actionId, outcome: action.outcome, values });
  }

  private dismiss(): void {
    if (this.closed) return;
    this.closed = true;
    this.done(undefined);
  }

  private cycleRange(): void {
    const field = this.element.actions.find(action => action.id === INSIGHTS_ACTIONS.range)?.input?.fields.find(candidate => candidate.id === INSIGHTS_ACTIONS.range);
    if (!this.dashboard || field?.kind !== 'enum') return;
    const ids = field.options.map(option => option.id);
    const next = ids[(ids.indexOf(this.dashboard.range.id) + 1) % ids.length];
    if (next !== undefined) this.submit(INSIGHTS_ACTIONS.range, { range: next });
  }

  private search(): void {
    if (!this.hasAction(INSIGHTS_ACTIONS.search) || this.closed) return;
    this.closed = true;
    this.done('search');
  }

  private selectTab(index: number): void {
    this.state.tab = TABS[index] ?? this.state.tab;
  }

  private current(): number {
    return this.state.scroll[this.state.tab] ?? 0;
  }

  private scrollBy(delta: number): void {
    this.setScroll(this.current() + delta);
  }

  private setScroll(value: number): void {
    this.state.scroll[this.state.tab] = Math.max(0, Math.min(this.maximum, value));
  }

  private pageSize(): number {
    return Math.max(1, this.terminalRows() - 8);
  }

  private hints(): string {
    if (!this.dashboard) return 'Esc close · ↑↓ PgUp/PgDn scroll';
    const extra = this.state.tab === 'overview' ? ' · m metric' : this.state.tab === 'projects' ? ' · s sort' : this.state.tab === 'sessions' ? ' · ←/→ pages' : '';
    return `Tab/1-5 tabs · ↑↓ PgUp/PgDn scroll · r range · / search · o open in browser${extra} · Esc close`;
  }

  private header(d: InsightsDashboard): string[] {
    const title = `${this.theme.fg('accent', this.theme.bold('Felan Code Insights'))}  ${clean(d.range.label)} · ${formatCount(d.totals.sessions)} sessions · ${d.projects.length} projects · ${d.models.length} models`;
    const tabs = TABS.map((tab, index) => tab === this.state.tab
      ? this.theme.fg('accent', this.theme.bold(`[${index + 1} ${TAB_LABELS[tab]}]`))
      : this.theme.fg('muted', `${index + 1} ${TAB_LABELS[tab]}`)).join('  ');
    const lines = [title, tabs];
    if (d.notice) lines.push(this.theme.fg(d.notice.level === 'warning' ? 'warning' : 'accent', clean(d.notice.text)));
    return [...lines, ''];
  }

  private heading(text: string): string {
    return this.theme.fg('accent', this.theme.bold(text));
  }

  private muted(text: string): string {
    return this.theme.fg('muted', text);
  }

  private tabBody(d: InsightsDashboard, width: number): string[] {
    switch (this.state.tab) {
      case 'overview': return this.overview(d, width);
      case 'models': return this.models(d, width);
      case 'projects': return this.projects(d, width);
      case 'sessions': return this.sessions(d, width);
      case 'rage': return this.rage(d, width);
    }
  }

  private overview(d: InsightsDashboard, width: number): string[] {
    const t = d.totals;
    const metric = this.state.metric;
    const values = d.daily.map(row => metric === 'sessions' ? row.sessions : metric === 'tokens' ? row.tokens : row.cost);
    const peak = Math.max(0, ...values);
    const lines = [
      `Sessions ${formatCount(t.sessions)}   Messages ${formatCount(t.messages)}   Active ${formatMinutes(t.durationMinutes)}   Avg session ${formatMinutes(t.avgSessionMinutes)}`,
      `Tokens ${formatCount(t.tokens)}   Cost ${formatMoney(t.cost)}   Multi-model sessions ${formatCount(t.multiModelSessions)}   Loaded ${formatCount(d.loadedSessions)}`,
      '',
      `${this.heading(`Per day · ${METRIC_LABELS[metric]}`)} ${this.muted('(m to change)')}`,
    ];
    if (!d.daily.length) lines.push(this.muted('No activity in this range.'));
    else {
      lines.push(this.theme.fg('accent', sparkline(values, Math.max(8, width - 2))));
      lines.push(this.muted(`${d.daily[0]!.date} → ${d.daily.at(-1)!.date} · peak ${metric === 'cost' ? formatMoney(peak) : formatCount(peak)}`));
    }
    lines.push('', this.heading('Activity calendar'), ...this.calendar(d, width), this.muted('less · ░ ▒ ▓ █ more'));
    lines.push('', this.heading('Session starts by hour (local time)'), this.theme.fg('accent', sparkline(d.hourly, 24)), this.muted(hourLabels(24)));
    lines.push('', this.heading('Top tools'));
    if (!d.tools.length) lines.push(this.muted('No tool usage recorded.'));
    const nameWidth = Math.min(24, Math.max(8, ...d.tools.map(tool => tool.name.length)));
    const maximum = Math.max(0, ...d.tools.map(tool => tool.count));
    for (const tool of d.tools) lines.push(`${clip(tool.name, nameWidth).padEnd(nameWidth)} ${this.theme.fg('accent', bar(tool.count, maximum, Math.max(4, width - nameWidth - 12)))} ${formatCount(tool.count)}`);
    lines.push('', this.muted(`Full HTML report: ${d.reportPath ?? 'not written'}`));
    return lines;
  }

  private calendar(d: InsightsDashboard, width: number): string[] {
    const weeks = Math.max(4, Math.min(53, Math.floor((width - 5) / 2)));
    const sessionsByDay = new Map(d.daily.map(row => [row.date, row.sessions]));
    const end = new Date(`${d.range.to.slice(0, 10)}T00:00:00Z`);
    const endWeekday = (end.getUTCDay() + 6) % 7;
    const start = end.getTime() - ((weeks - 1) * 7 + endWeekday) * DAY_MS;
    return WEEKDAYS.map((name, row) => {
      const cells: string[] = [];
      for (let week = 0; week < weeks; week++) {
        const date = new Date(start + (week * 7 + row) * DAY_MS);
        if (date.getTime() > end.getTime()) { cells.push(' '); continue; }
        const level = heatLevel(sessionsByDay.get(date.toISOString().slice(0, 10)) ?? 0);
        cells.push(level === 0 ? this.theme.fg('dim', '·') : this.theme.fg('accent', shade(level)));
      }
      return `${name} ${cells.join(' ')}`;
    });
  }

  private models(d: InsightsDashboard, width: number): string[] {
    if (!d.models.length) return [this.muted('No model usage in this range.')];
    const nameWidth = Math.min(24, Math.max(8, ...d.models.map(model => model.name.length)));
    const maximum = Math.max(0, ...d.models.map(model => model.tokens));
    const chips = (entries: typeof d.thinkingLevels) => entries.length ? entries.map(entry => `${entry.name} ${formatCount(entry.count)}`).join(' · ') : this.muted('—');
    return [
      this.heading('Token share'),
      ...d.models.map(model => `${clip(model.name, nameWidth).padEnd(nameWidth)} ${this.theme.fg('accent', bar(model.tokens, maximum, Math.max(4, width - nameWidth - 26)))} ${formatCount(model.tokens)} tokens`),
      '',
      this.heading('Efficiency'),
      ...d.models.map(model => `${clip(model.name, nameWidth).padEnd(nameWidth)} ${model.sessions} sessions · ${model.messages} msgs · ${formatMoney(model.cost)} · ${formatMoney(model.messages ? model.cost / model.messages : 0)}/msg · ${formatMinutes(model.avgSessionMinutes)} avg · ${model.toolErrorsPerSession.toFixed(1)} tool errors/session`),
      '',
      this.heading('Thinking levels'), chips(d.thinkingLevels),
      this.heading('Stop reasons'), chips(d.stopReasons),
    ];
  }

  private projects(d: InsightsDashboard, width: number): string[] {
    const key = this.state.sort;
    const value = (project: InsightsDashboard['projects'][number]) => project[key];
    const rows = [...d.projects].sort((left, right) => value(right) - value(left));
    const lines = [this.muted(`Sorted by ${key} (s to change)`), ''];
    if (!rows.length) return [...lines, this.muted('No projects in this range.')];
    const nameWidth = Math.min(28, Math.max(8, ...rows.map(row => row.name.length)));
    const maximum = Math.max(0, ...rows.map(value));
    const format = (project: InsightsDashboard['projects'][number]) => key === 'cost' ? formatMoney(project.cost) : formatCount(value(project));
    for (const row of rows) {
      lines.push(`${clip(row.name, nameWidth).padEnd(nameWidth)} ${this.theme.fg('accent', bar(value(row), maximum, Math.max(4, width - nameWidth - 40)))} ${format(row).padStart(8)} · ${row.sessions} sessions · ${formatMoney(row.cost)} · ${formatMinutes(row.durationMinutes)}`);
    }
    return lines;
  }

  private sessions(d: InsightsDashboard, width: number): string[] {
    const page = d.sessions;
    const projectWidth = Math.max(10, Math.min(28, width - 66));
    const lines = [
      this.muted(`${page.query ? `Search “${clean(page.query)}” · ` : ''}${formatCount(page.matched)} matching · page ${page.page + 1} of ${page.pageCount}`),
      '',
      this.heading(`${'Start'.padEnd(17)} ${'Project'.padEnd(projectWidth)} ${'Msgs'.padStart(5)} ${'Tokens'.padStart(8)} ${'Time'.padStart(7)} ${'Cost'.padStart(9)}  Models`),
    ];
    if (!page.rows.length) lines.push(this.muted('No sessions match this search.'));
    for (const row of page.rows) {
      lines.push(`${startLabel(row.start).padEnd(17)} ${clip(row.project, projectWidth).padEnd(projectWidth)} ${String(row.messages).padStart(5)} ${formatCount(row.tokens).padStart(8)} ${formatMinutes(row.durationMinutes).padStart(7)} ${formatMoney(row.cost).padStart(9)}  ${row.models.join(', ')}`);
    }
    return lines;
  }

  private rage(d: InsightsDashboard, width: number): string[] {
    const rage = d.rage;
    if (rage.total === 0) return [this.muted('No profanity detected in this range.')];
    const peak = rage.byHour.reduce((best, count, hour) => count > best.count ? { hour, count } : best, { hour: 0, count: 0 });
    const names = [...rage.byModel.map(entry => entry.name), ...rage.byProject.map(entry => entry.name), ...rage.topWords.map(entry => entry.word)];
    const nameWidth = Math.min(24, Math.max(8, ...names.map(name => name.length)));
    const section = (title: string, entries: Array<{ name: string; count: number }>) => {
      const maximum = Math.max(0, ...entries.map(entry => entry.count));
      return [this.heading(title), ...entries.map(entry => `${clip(entry.name, nameWidth).padEnd(nameWidth)} ${this.theme.fg('accent', bar(entry.count, maximum, Math.max(4, width - nameWidth - 12)))} ${formatCount(entry.count)}`)];
    };
    return [
      `Swears ${formatCount(rage.total)} · messages with swears ${formatCount(rage.messagesWithSwears)} · ${formatPercent(d.totals.userMessages ? rage.messagesWithSwears / d.totals.userMessages : 0)} of user messages`,
      `Peak hour ${pad2(peak.hour)}:00 (${formatCount(peak.count)}) · filthiest model ${rage.byModel[0]?.name ?? '—'}`,
      '',
      this.heading('By hour'), this.theme.fg('accent', sparkline(rage.byHour, 24)), this.muted(hourLabels(24)), '',
      ...section('By model', rage.byModel), '',
      ...section('Top words', rage.topWords.map(entry => ({ name: entry.word, count: entry.count }))), '',
      ...section('By project', rage.byProject),
    ];
  }
}
