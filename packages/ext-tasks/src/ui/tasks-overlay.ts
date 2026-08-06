import type { ExtensionContext } from '@felan-ai/agent-core';
import { matchesKey, truncateToWidth } from '@earendil-works/pi-tui';
import type { Task, TaskState } from '../contracts.js';
import { emptyTaskState, listTasks, taskAvailability } from '../graph.js';
import {
  formatTaskDetails,
  formatTaskLine,
  formatTaskSummary,
  taskGraphLayers,
} from '../presentation.js';
import type { TaskStore } from '../store.js';

const LIST_ROWS = 18;
const CONTENT_ROWS = 24;
const PADDING_X = 2;
const PADDING_Y = 1;

type Theme = ExtensionContext['ui']['theme'];
type View = 'list' | 'detail' | 'graph';

export class TasksOverlay {
  readonly #unsubscribe: () => void;
  #state: TaskState = emptyTaskState();
  #tasks: Task[] = [];
  #selected = 0;
  #scroll = 0;
  #contentScroll = 0;
  #loading = true;
  #message = '';
  #view: View = 'list';
  #disposed = false;

  constructor(
    private readonly store: TaskStore,
    private readonly theme: Theme,
    private readonly done: () => void,
    private readonly requestRender: () => void,
    private readonly onDispose: () => void = () => {},
  ) {
    this.#unsubscribe = store.subscribe((state) => {
      if (this.#disposed) return;
      this.#setState(state);
      this.requestRender();
    });
    void this.#refresh();
  }

  handleInput(data: string): void {
    if (this.#disposed) return;
    if (matchesKey(data, 'escape') || data === 'q') {
      this.#close();
      return;
    }
    if (data === 'r') {
      void this.#refresh();
      return;
    }
    if (data === 'g') {
      this.#view = this.#view === 'graph' ? 'list' : 'graph';
      this.#contentScroll = 0;
      this.requestRender();
      return;
    }
    if (this.#view === 'detail') {
      if (matchesKey(data, 'backspace') || matchesKey(data, 'left')) {
        this.#view = 'list';
        this.#contentScroll = 0;
        this.requestRender();
      } else {
        this.#handleContentInput(data);
      }
      return;
    }
    if (this.#view === 'graph') {
      this.#handleContentInput(data);
      return;
    }
    if (matchesKey(data, 'up') || data === 'k') this.#select(-1);
    if (matchesKey(data, 'down') || data === 'j') this.#select(1);
    if (matchesKey(data, 'ctrl+u')) this.#select(-LIST_ROWS);
    if (matchesKey(data, 'ctrl+d')) this.#select(LIST_ROWS);
    if (matchesKey(data, 'home')) this.#select(-this.#tasks.length);
    if (matchesKey(data, 'end')) this.#select(this.#tasks.length);
    if ((matchesKey(data, 'return') || matchesKey(data, 'right')) && this.#tasks.length > 0) {
      this.#view = 'detail';
      this.#contentScroll = 0;
      this.requestRender();
    }
  }

  render(width: number): string[] {
    const lines = this.#view === 'detail'
      ? this.#renderDetail()
      : this.#view === 'graph'
        ? this.#renderGraph()
        : this.#renderList();
    const innerWidth = Math.max(1, width - PADDING_X * 2);
    const prefix = ' '.repeat(PADDING_X);
    const padded = lines.map((line) => `${prefix}${truncateToWidth(line, innerWidth, '…')}${prefix}`);
    return [...Array<string>(PADDING_Y).fill(''), ...padded, ...Array<string>(PADDING_Y).fill('')];
  }

  invalidate(): void {}

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribe();
    this.onDispose();
  }

  #renderList(): string[] {
    const lines = [
      this.theme.fg('accent', this.theme.bold('Session Tasks'))
      + this.theme.fg('dim', '  ↑↓ select • enter/→ details • g graph • r refresh • q/esc close'),
      this.theme.fg('muted', formatTaskSummary(this.#state)),
    ];
    if (this.#loading) lines.push(this.theme.fg('warning', 'Refreshing...'));
    if (this.#message) lines.push(this.theme.fg('muted', this.#message));
    lines.push('');
    if (this.#tasks.length === 0) {
      lines.push(this.theme.fg('dim', 'No session tasks.'));
      return lines;
    }
    const end = Math.min(this.#tasks.length, this.#scroll + LIST_ROWS);
    lines.push(this.theme.fg('dim', `Showing tasks ${this.#scroll + 1}-${end}/${this.#tasks.length}`));
    for (let index = this.#scroll; index < end; index += 1) {
      const task = this.#tasks[index]!;
      const marker = index === this.#selected ? this.theme.fg('accent', '▶') : ' ';
      lines.push(`${marker} ${statusIcon(task, this.#state, this.theme)} ${formatTaskLine(task, this.#state)}`);
    }
    return lines;
  }

  #renderDetail(): string[] {
    const task = this.#tasks[this.#selected];
    if (!task) return [this.theme.fg('dim', 'No task selected.')];
    return this.#renderScrollable([
      this.theme.fg('accent', this.theme.bold(task.id))
      + this.theme.fg('dim', '  backspace/← tasks • ↑↓ scroll • g graph • r refresh • q/esc close'),
    ], ['', ...formatTaskDetails(this.#state, task).split('\n')]);
  }

  #renderGraph(): string[] {
    const header = [
      this.theme.fg('accent', this.theme.bold('Task Graph'))
      + this.theme.fg('dim', '  ↑↓ scroll • g tasks • r refresh • q/esc close'),
      this.theme.fg('muted', formatTaskSummary(this.#state)),
    ];
    const lines = [''];
    const layers = taskGraphLayers(this.#state);
    if (layers.length === 0) return [...header, '', this.theme.fg('dim', 'No session tasks.')];
    layers.forEach((layer, index) => {
      lines.push(this.theme.fg('accent', `Layer ${index}`));
      for (const task of layer) {
        const prerequisites = task.blockedBy.length > 0 ? ` ← ${task.blockedBy.join(', ')}` : '';
        lines.push(`  ${statusIcon(task, this.#state, this.theme)} ${task.id} ${task.title}${prerequisites}`);
      }
      lines.push('');
    });
    return this.#renderScrollable(header, lines);
  }

  async #refresh(): Promise<void> {
    if (this.#disposed) return;
    this.#loading = true;
    this.requestRender();
    try {
      const state = await this.store.snapshot();
      if (this.#disposed) return;
      this.#setState(state);
      this.#message = `Last refresh: ${new Date().toLocaleTimeString()}`;
    } catch (error) {
      if (this.#disposed) return;
      this.#message = error instanceof Error ? error.message : String(error);
    } finally {
      if (!this.#disposed) {
        this.#loading = false;
        this.requestRender();
      }
    }
  }

  #setState(state: TaskState): void {
    const selectedId = this.#tasks[this.#selected]?.id;
    this.#state = state;
    this.#tasks = listTasks(state, 'all');
    const nextSelected = selectedId ? this.#tasks.findIndex((task) => task.id === selectedId) : -1;
    this.#selected = nextSelected >= 0
      ? nextSelected
      : Math.min(this.#selected, Math.max(0, this.#tasks.length - 1));
    this.#clampScroll();
    this.#clampContentScroll();
  }

  #select(delta: number): void {
    if (this.#tasks.length === 0) return;
    this.#selected = Math.max(0, Math.min(this.#tasks.length - 1, this.#selected + delta));
    this.#clampScroll();
    this.requestRender();
  }

  #clampScroll(): void {
    if (this.#selected < this.#scroll) this.#scroll = this.#selected;
    if (this.#selected >= this.#scroll + LIST_ROWS) this.#scroll = this.#selected - LIST_ROWS + 1;
    this.#scroll = Math.max(0, Math.min(this.#scroll, Math.max(0, this.#tasks.length - LIST_ROWS)));
  }

  #handleContentInput(data: string): void {
    if (matchesKey(data, 'up') || data === 'k') this.#scrollContent(-1);
    if (matchesKey(data, 'down') || data === 'j') this.#scrollContent(1);
    if (matchesKey(data, 'ctrl+u')) this.#scrollContent(-CONTENT_ROWS);
    if (matchesKey(data, 'ctrl+d')) this.#scrollContent(CONTENT_ROWS);
    if (matchesKey(data, 'home')) this.#scrollContent(-this.#contentLength());
    if (matchesKey(data, 'end')) this.#scrollContent(this.#contentLength());
  }

  #scrollContent(delta: number): void {
    this.#contentScroll += delta;
    this.#clampContentScroll();
    this.requestRender();
  }

  #clampContentScroll(): void {
    this.#contentScroll = Math.max(
      0,
      Math.min(this.#contentScroll, Math.max(0, this.#contentLength() - CONTENT_ROWS)),
    );
  }

  #contentLength(): number {
    if (this.#view === 'detail') {
      const task = this.#tasks[this.#selected];
      return task ? formatTaskDetails(this.#state, task).split('\n').length + 1 : 0;
    }
    if (this.#view === 'graph') {
      return taskGraphLayers(this.#state).reduce((count, layer) => count + layer.length + 2, 1);
    }
    return 0;
  }

  #renderScrollable(header: string[], body: string[]): string[] {
    const maxScroll = Math.max(0, body.length - CONTENT_ROWS);
    this.#contentScroll = Math.min(this.#contentScroll, maxScroll);
    const end = Math.min(body.length, this.#contentScroll + CONTENT_ROWS);
    const range = body.length > CONTENT_ROWS
      ? this.theme.fg('dim', `Showing lines ${this.#contentScroll + 1}-${end}/${body.length}`)
      : '';
    return [...header, ...(range ? [range] : []), ...body.slice(this.#contentScroll, end)];
  }

  #close(): void {
    this.dispose();
    this.done();
  }
}

function statusIcon(task: Task, state: TaskState, theme: Theme): string {
  const availability = taskAvailability(task, state);
  if (availability === 'completed') return theme.fg('success', '✓');
  if (availability === 'in_progress') return theme.fg('accent', '◐');
  if (availability === 'blocked' || availability === 'waiting') return theme.fg('warning', '⊘');
  if (availability === 'cancelled') return theme.fg('dim', '×');
  return theme.fg('muted', '○');
}
