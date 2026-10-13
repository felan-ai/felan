import type { Theme } from '@earendil-works/pi-coding-agent';
import { Container, CURSOR_MARKER, Editor, Input, SelectList, Text, getKeybindings, stripTerminalSequences, type Component, type OverlayHandle, type OverlayOptions, type SelectItem, type TUI } from '@earendil-works/pi-tui';
import { clientSelectListTheme, defaultClientTheme } from './theme.js';

export interface DialogOptions { signal?: AbortSignal; timeout?: number; placeholder?: string; secret?: boolean }

export interface TuiDialogHost {
  select(title: string, choices: readonly SelectItem[], options?: DialogOptions): Promise<string | undefined>;
  input(title: string, initial?: string, options?: DialogOptions): Promise<string | undefined>;
  confirm(title: string, message: string, options?: DialogOptions): Promise<boolean>;
}

export class TuiDialogs implements TuiDialogHost {
  private readonly active = new Set<() => void>();
  private closed = false;
  private readonly theme: () => Theme;
  constructor(private readonly tui: TUI, theme?: () => Theme, private readonly inline?: (component: Component) => () => void) {
    const initial = theme ? undefined : defaultClientTheme(); this.theme = theme ?? (() => initial!);
  }

  select(title: string, choices: readonly SelectItem[], options: DialogOptions = {}): Promise<string | undefined> {
    return this.show<string>(finish => {
      const content = new Container(); const search = new Input({ placeholder: 'Filter choices' });
      const items = choices.map(choice => ({ ...choice, label: stripTerminalSequences(choice.label),
        ...(choice.description ? { description: stripTerminalSequences(choice.description) } : {}) }));
      const makeList = (filter = '') => {
        const prefix = filter.toLowerCase();
        const result = new SelectList(items.filter(item => item.label.toLowerCase().startsWith(prefix) || item.value.toLowerCase().startsWith(prefix)), 12, clientSelectListTheme(this.theme));
        result.onSelect = item => finish(item.value); result.onCancel = () => finish(undefined);
        return result;
      };
      let list = makeList();
      content.addChild(new Text(this.theme().fg('accent', this.theme().bold(stripTerminalSequences(title))), 1, 1)); content.addChild(search); content.addChild(list);
      return {
        render: width => this.frame(content.render(width), width), invalidate: () => content.invalidate(),
        handleInput: data => {
          if ((['tui.select.up', 'tui.select.down', 'tui.select.confirm', 'tui.select.cancel'] as const).some(key => getKeybindings().matches(data, key))) list.handleInput(data);
          else {
            const previous = search.getValue(); search.handleInput(data);
            if (search.getValue() !== previous) {
              content.removeChild(list); list = makeList(search.getValue()); content.addChild(list);
            }
          }
          this.tui.requestRender();
        },
      };
    }, options);
  }

  input(title: string, initial = '', options: DialogOptions = {}): Promise<string | undefined> {
    return this.show<string>(finish => {
      const content = new Container(); const input = new Input(options.placeholder ? { placeholder: options.placeholder } : {}); input.setValue(initial); input.focused = true;
      input.onSubmit = value => finish(value); input.onEscape = () => finish(undefined);
      content.addChild(new Text(this.theme().fg('accent', this.theme().bold(stripTerminalSequences(title))), 1, 1));
      if (options.secret) content.addChild(new Text('Input is hidden. Enter submits; Escape cancels.', 1, 0));
      else content.addChild(input);
      return {
        render: width => this.frame(options.secret
          ? [...content.render(width), `${'*'.repeat(Math.min(input.getValue().length, Math.max(0, width - 1)))}${CURSOR_MARKER}`]
          : content.render(width), width),
        invalidate: () => content.invalidate(),
        handleInput: data => { input.handleInput(data); this.tui.requestRender(); },
        dispose: () => { input.setValue(''); },
      };
    }, options);
  }

  async confirm(title: string, message: string, options: DialogOptions = {}): Promise<boolean> {
    return await this.select(`${title}\n\n${message}`, [{ value: 'no', label: 'No' }, { value: 'yes', label: 'Yes' }], options) === 'yes';
  }

  editor(title: string, initial: string, options: DialogOptions = {}): Promise<string | undefined> {
    return this.show<string>(finish => {
      const content = new Container(); const theme = clientSelectListTheme(this.theme);
      const editor = new Editor(this.tui, { borderColor: text => this.theme().fg('accent', text), selectList: theme }); editor.setText(initial);
      editor.onSubmit = value => finish(value);
      content.addChild(new Text(this.theme().fg('accent', this.theme().bold(stripTerminalSequences(title))), 1, 1)); content.addChild(editor);
      return { render: width => content.render(width).map(line => this.theme().fg('text', line)), invalidate: () => content.invalidate(), handleInput: data => {
        if (getKeybindings().matches(data, 'tui.select.cancel')) finish(undefined); else editor.handleInput(data);
        this.tui.requestRender();
      } };
    }, options);
  }

  custom<T>(factory: (done: (value: T) => void) => Component | Promise<Component>, options: {
    overlay?: boolean; overlayOptions?: OverlayOptions | (() => OverlayOptions); onHandle?: (handle: OverlayHandle) => void; signal?: AbortSignal;
  } = {}): Promise<T | undefined> { return this.show<T>(factory, options, options); }

  dispose(): void { this.closed = true; for (const cancel of [...this.active]) cancel(); }

  private frame(lines: string[], width: number): string[] {
    const border = this.theme().fg('border', '─'.repeat(width));
    return [border, ...lines.map(line => this.theme().fg('text', line)), border];
  }

  private show<T>(factory: (finish: (value: T | undefined) => void) => Component | Promise<Component>, options: DialogOptions = {}, overlay: {
    overlay?: boolean; overlayOptions?: OverlayOptions | (() => OverlayOptions); onHandle?: (handle: OverlayHandle) => void;
  } = {}): Promise<T | undefined> {
    if (this.closed) return Promise.resolve(undefined);
    if (options.signal?.aborted) return Promise.resolve(undefined);
    return new Promise((resolve, reject) => {
      let handle: OverlayHandle | undefined; let unmount: (() => void) | undefined;
      let component: Component | undefined; let settled = false; let timer: ReturnType<typeof setTimeout> | undefined;
      const release = () => {
        this.active.delete(cancel); options.signal?.removeEventListener('abort', cancel); clearTimeout(timer); handle?.hide(); unmount?.();
        if (component && 'dispose' in component && typeof component.dispose === 'function') component.dispose();
      };
      const finish = (value: T | undefined) => {
        if (settled) return;
        settled = true;
        try { release(); resolve(value); } catch (error) { reject(error); }
      };
      const cancel = () => finish(undefined); this.active.add(cancel);
      options.signal?.addEventListener('abort', cancel, { once: true });
      if (options.timeout !== undefined) timer = setTimeout(cancel, options.timeout);
      const failed = (error: unknown) => {
        if (settled) return;
        settled = true;
        try { release(); reject(error); } catch (cleanup) { reject(new AggregateError([error, cleanup], 'Dialog cleanup failed.')); }
      };
      try {
        const made = factory(finish);
        const mount = (value: Component) => {
          component = value;
          if (settled) { if ('dispose' in value && typeof value.dispose === 'function') value.dispose(); return; }
          if (this.inline && !overlay.overlay && !this.tui.hasOverlay()) { unmount = this.inline(value); return; }
          const position = typeof overlay.overlayOptions === 'function' ? overlay.overlayOptions() : overlay.overlayOptions;
          handle = this.tui.showOverlay(value, position ?? { width: '85%', maxHeight: '85%', anchor: 'center' });
          overlay.onHandle?.(handle);
        };
        if (made instanceof Promise) void made.then(mount).catch(failed); else mount(made);
      } catch (error) { failed(error); }
    });
  }
}
