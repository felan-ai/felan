import {
  ToolExecutionComponent,
  type Theme,
} from '@earendil-works/pi-coding-agent';
import {
  matchesKey,
  stripTerminalSequences,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
  type TUI,
} from '@earendil-works/pi-tui';
import { toolCallLabel } from './presentation.js';
import {
  type ToolActivityCall,
  ToolActivityState,
} from './state.js';

const LIST_ROWS = 8;
const MIN_DETAIL_ROWS = 6;
const MAX_DETAIL_ROWS = 24;
const MAX_SERIALIZED_CHARACTERS = 200_000;
const PADDING_X = 2;
const PADDING_Y = 1;

export class ToolActivityInspector implements Component {
  readonly #unsubscribe: () => void;
  readonly #detailRows: number;
  #selected = 0;
  #listScroll = 0;
  #detailScroll = 0;
  #detailLength = 0;
  #detailComponent: ToolExecutionComponent | undefined;
  #detailSource: {
    readonly callId: string;
    readonly args: unknown;
    readonly result: ToolActivityCall['result'];
    readonly status: ToolActivityCall['status'];
    readonly definition: ReturnType<ToolActivityState['definition']>;
  } | undefined;
  #disposed = false;

  constructor(
    private readonly state: ToolActivityState,
    private readonly theme: Theme,
    private readonly tui: TUI,
    private readonly done: () => void,
    private readonly onDispose: () => void = () => {},
  ) {
    this.#detailRows = Math.max(
      MIN_DETAIL_ROWS,
      Math.min(MAX_DETAIL_ROWS, tui.terminal.rows - LIST_ROWS - 9),
    );
    this.#selected = Math.max(0, state.calls().length - 1);
    this.#clampList();
    this.#syncDetailComponent();
    this.#unsubscribe = state.subscribe(() => {
      if (this.#disposed) return;
      this.#selected = Math.min(this.#selected, Math.max(0, state.calls().length - 1));
      this.#clampList();
      this.#syncDetailComponent();
      this.tui.requestRender();
    });
  }

  handleInput(data: string): void {
    if (this.#disposed) return;
    if (matchesKey(data, 'escape') || data === 'q') {
      this.close();
      return;
    }
    if (matchesKey(data, 'up') || data === 'k') this.#select(-1);
    if (matchesKey(data, 'down') || data === 'j') this.#select(1);
    if (matchesKey(data, 'ctrl+u') || matchesKey(data, 'pageUp')) this.#scrollDetail(-this.#detailRows);
    if (matchesKey(data, 'ctrl+d') || matchesKey(data, 'pageDown')) this.#scrollDetail(this.#detailRows);
    if (matchesKey(data, 'home')) this.#scrollDetail(-this.#detailLength);
    if (matchesKey(data, 'end')) this.#scrollDetail(this.#detailLength);
  }

  render(width: number): string[] {
    const renderWidth = Math.max(1, Math.floor(width));
    const innerWidth = Math.max(1, renderWidth - PADDING_X * 2);
    const calls = this.state.calls();
    const lines = [
      this.theme.fg('accent', this.theme.bold('Tool Activity'))
      + this.theme.fg('dim', '  ↑↓ select • ctrl+u/d detail • home/end • q/esc close'),
      this.theme.fg('muted', `${calls.length} tool call${calls.length === 1 ? '' : 's'}`),
      '',
    ];

    if (calls.length === 0) {
      lines.push(this.theme.fg('dim', 'No tool activity in this session.'));
      return frameInlineLines(pad(lines, innerWidth), renderWidth, this.theme);
    }

    const listEnd = Math.min(calls.length, this.#listScroll + LIST_ROWS);
    lines.push(this.theme.fg('dim', `Showing calls ${this.#listScroll + 1}-${listEnd}/${calls.length}`));
    for (let index = this.#listScroll; index < listEnd; index += 1) {
      const call = calls[index]!;
      const marker = index === this.#selected ? this.theme.fg('accent', '▶') : ' ';
      lines.push(`${marker} ${statusIcon(call, this.theme)} ${toolCallLabel(call)}`);
    }

    const selected = calls[this.#selected]!;
    const renderedView = this.#detailComponent
      ?.render(innerWidth)
      .map((line) => line.trimEnd())
      .filter((line) => stripTerminalSequences(line).trim().length > 0) ?? [];
    const detailLines = wrapTextWithAnsi(formatDetail(selected, this.theme, renderedView), innerWidth);
    this.#detailLength = detailLines.length;
    this.#clampDetail();
    const detailEnd = Math.min(detailLines.length, this.#detailScroll + this.#detailRows);
    lines.push('', this.theme.fg('muted', '─'.repeat(Math.max(1, Math.min(innerWidth, 80)))));
    if (detailLines.length > this.#detailRows) {
      lines.push(this.theme.fg(
        'dim',
        `Showing detail lines ${this.#detailScroll + 1}-${detailEnd}/${detailLines.length}`,
      ));
    }
    lines.push(...detailLines.slice(this.#detailScroll, detailEnd));
    return frameInlineLines(pad(lines, innerWidth), renderWidth, this.theme);
  }

  invalidate(): void {}

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribe();
    this.onDispose();
  }

  close(): void {
    if (this.#disposed) return;
    this.dispose();
    this.done();
  }

  #select(delta: number): void {
    const calls = this.state.calls();
    if (calls.length === 0) return;
    this.#selected = Math.max(0, Math.min(calls.length - 1, this.#selected + delta));
    this.#detailScroll = 0;
    this.#clampList();
    this.#syncDetailComponent();
    this.tui.requestRender();
  }

  #clampList(): void {
    const length = this.state.calls().length;
    if (this.#selected < this.#listScroll) this.#listScroll = this.#selected;
    if (this.#selected >= this.#listScroll + LIST_ROWS) {
      this.#listScroll = this.#selected - LIST_ROWS + 1;
    }
    this.#listScroll = Math.max(0, Math.min(this.#listScroll, Math.max(0, length - LIST_ROWS)));
  }

  #scrollDetail(delta: number): void {
    this.#detailScroll += delta;
    this.#clampDetail();
    this.tui.requestRender();
  }

  #clampDetail(): void {
    this.#detailScroll = Math.max(
      0,
      Math.min(this.#detailScroll, Math.max(0, this.#detailLength - this.#detailRows)),
    );
  }

  #syncDetailComponent(): void {
    const call = this.state.calls()[this.#selected];
    const definition = call ? this.state.definition(call.name) : undefined;
    if (
      call
      && this.#detailSource?.callId === call.id
      && this.#detailSource.args === call.args
      && this.#detailSource.result === call.result
      && this.#detailSource.status === call.status
      && this.#detailSource.definition === definition
    ) return;

    this.#detailSource = call
      ? { callId: call.id, args: call.args, result: call.result, status: call.status, definition }
      : undefined;
    this.#detailComponent = undefined;
    if (!call || !definition || !call.result || call.status === 'pending' || call.status === 'running') return;

    const component = new ToolExecutionComponent(
      call.name,
      call.id,
      call.args,
      { showImages: false },
      definition,
      this.tui,
      this.state.cwd,
    );
    component.markExecutionStarted();
    const renderedResult = definition.renderResult ? call.result : { content: [] };
    component.updateResult({
      content: [...renderedResult.content],
      ...(renderedResult.details === undefined ? {} : { details: renderedResult.details }),
      isError: call.isError,
    });
    component.setArgsComplete();
    component.setExpanded(true);
    this.#detailComponent = component;
  }
}

function formatDetail(
  call: ToolActivityCall,
  theme: Theme,
  renderedView: readonly string[],
): string {
  const lines = [
    `${statusIcon(call, theme)} ${theme.bold(toolCallLabel(call))}`,
    theme.fg('muted', `${call.name} · ${call.id} · ${statusLabel(call)}`),
  ];

  if (renderedView.length > 0) {
    lines.push('', theme.fg('accent', theme.bold('Rendered view')), ...renderedView);
  }
  lines.push('', theme.fg('accent', theme.bold('Arguments')), sanitize(serialized(call.args)));

  if (call.result) {
    lines.push('', theme.fg('accent', theme.bold(call.isError ? 'Error result' : 'Result')));
    if (call.result.content.length === 0) {
      lines.push(theme.fg('dim', '(no content)'));
    } else {
      for (const content of call.result.content) {
        if (content.type === 'text') lines.push(sanitize(content.text ?? ''));
        else if (content.type === 'image') {
          lines.push(theme.fg(
            'dim',
            `[${content.mimeType ?? 'image'} · ${content.data?.length ?? 0} encoded characters]`,
          ));
        } else {
          lines.push(theme.fg('dim', `[${content.type}]`));
        }
      }
    }
    if (call.result.details !== undefined) {
      lines.push('', theme.fg('accent', theme.bold('Details')), sanitize(serialized(call.result.details)));
    }
  } else {
    lines.push('', theme.fg('warning', 'Result pending…'));
  }
  return lines.join('\n');
}

function serialized(value: unknown): string {
  try {
    const seen = new WeakSet<object>();
    const text = JSON.stringify(value, (key, entry: unknown) => {
      if (isSensitiveKey(key)) return '[redacted]';
      if (typeof entry === 'bigint') return entry.toString();
      if (typeof entry === 'string' && entry.length > MAX_SERIALIZED_CHARACTERS) {
        return `${entry.slice(0, MAX_SERIALIZED_CHARACTERS)}… ${entry.length - MAX_SERIALIZED_CHARACTERS} characters omitted`;
      }
      if (typeof entry !== 'object' || entry === null) return entry;
      if (seen.has(entry)) return '[Circular]';
      seen.add(entry);
      return entry;
    }, 2) ?? String(value);
    if (text.length <= MAX_SERIALIZED_CHARACTERS) return text;
    return `${text.slice(0, MAX_SERIALIZED_CHARACTERS)}\n… ${text.length - MAX_SERIALIZED_CHARACTERS} characters omitted`;
  } catch {
    return String(value);
  }
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return [
    'apikey',
    'authorization',
    'cookie',
    'password',
    'privatekey',
    'refreshtoken',
    'secret',
    'token',
    'accesstoken',
  ].includes(normalized);
}

function sanitize(value: string): string {
  return stripTerminalSequences(value);
}

function statusIcon(call: ToolActivityCall, theme: Theme): string {
  if (call.isError) return theme.fg('error', '✗');
  if (call.status === 'pending' || call.status === 'running') return theme.fg('warning', '◌');
  return theme.fg('success', '✓');
}

function statusLabel(call: ToolActivityCall): string {
  if (call.isPartial && call.status === 'running') return 'running · partial result';
  return call.status;
}

function pad(lines: readonly string[], width: number): string[] {
  const prefix = ' '.repeat(PADDING_X);
  return [
    ...Array<string>(PADDING_Y).fill(''),
    ...lines.map((line) => `${prefix}${truncateToWidth(line, width, '…')}${prefix}`),
    ...Array<string>(PADDING_Y).fill(''),
  ];
}

function frameInlineLines(lines: readonly string[], width: number, theme: Theme): string[] {
  const border = (text: string) => theme.fg('border', text);
  return [
    border('─'.repeat(width)),
    ...lines.map((line) => truncateToWidth(line, width, '', true)),
    border('─'.repeat(width)),
  ];
}
