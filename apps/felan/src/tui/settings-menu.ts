import type { Theme } from '@earendil-works/pi-coding-agent';
import { Input, SelectList, SettingsList, Text, getKeybindings, stripTerminalSequences, type Component, type SettingItem } from '@earendil-works/pi-tui';
import { clientSelectListTheme } from './theme.js';

export interface SettingsEntry {
  id: string;
  label: string;
  description: string;
  currentValue: string;
  values?: string[];
  children?: SettingsEntry[];
  choices?: { value: string; label: string; description?: string }[];
  edit?: boolean;
  preview?(value: string | undefined): void;
  change?(value: string): Promise<string | void>;
}

export class SettingsMenu implements Component {
  private readonly list: SettingsList;
  private pending = false;
  private error = '';

  constructor(entries: SettingsEntry[], private readonly theme: () => Theme, private readonly renderRequested: () => void, close: () => void, selected?: string) {
    const items: SettingItem[] = entries.map(entry => ({
      id: entry.id, label: stripTerminalSequences(entry.label), description: stripTerminalSequences(entry.description),
      currentValue: stripTerminalSequences(entry.currentValue), ...(entry.values ? { values: entry.values } : {}),
      ...(entry.children ? { submenu: (_value: string, done: () => void) => new SettingsMenu(entry.children!, theme, renderRequested, done) }
        : entry.choices && entry.preview ? { submenu: (_value: string, done: () => void) => {
          const input = new Input(); input.focused = true;
          const choices = [...entry.choices!.map(choice => ({ ...choice, label: `${choice.value === entry.currentValue ? '✓ ' : ''}${stripTerminalSequences(choice.label)}` })),
            ...(entry.edit ? [{ value: 'custom-value', label: 'Custom value…' }] : [])];
          const list = new SelectList(choices, 12, clientSelectListTheme(theme));
          const at = choices.findIndex(choice => choice.value === entry.currentValue);
          if (at >= 0) list.setSelectedIndex(at);
          let editing = false;
          const save = (value: string) => { void this.change(entry, value).then(saved => { if (saved) { entry.preview!(undefined); done(); } }); };
          input.onSubmit = value => { if (editing) save(value); };
          input.onEscape = () => { entry.preview!(undefined); done(); };
          list.onSelect = item => {
            if (item.value === 'custom-value') { editing = true; input.setValue(entry.currentValue); }
            else save(item.value);
          };
          list.onCancel = () => { entry.preview!(undefined); done(); };
          list.onSelectionChange = item => entry.preview!(item.value === 'custom-value' ? undefined : item.value);
          entry.preview!(list.getSelectedItem()?.value);
          return { render: (width: number) => [...new Text(entry.label, 1, 1).render(width), ...input.render(width), ...(editing ? [] : [...list.render(width),
            ...new Text(theme().fg('dim', choices.find(choice => choice.value === list.getSelectedItem()?.value)?.description ?? ''), 1, 0).render(width),
            ...new Text(theme().fg('dim', `${getKeybindings().getKeys('tui.select.up').join('/')} / ${getKeybindings().getKeys('tui.select.down').join('/')} navigate · ${getKeybindings().getKeys('tui.select.confirm').join('/')} select · ${getKeybindings().getKeys('tui.select.cancel').join('/')} back`), 1, 0).render(width)])],
            invalidate: () => list.invalidate(), handleInput: (data: string) => {
              if (this.pending) return;
              const keys = getKeybindings();
              if (editing) input.handleInput(data);
              else if ((['tui.select.up', 'tui.select.down', 'tui.select.confirm', 'tui.select.cancel'] as const).some(key => keys.matches(data, key))) list.handleInput(data);
              else { input.handleInput(data); list.setFilter(input.getValue()); }
              renderRequested();
            } };
        } }
        : entry.choices ? { submenu: (_value: string, done: () => void) => new SettingsMenu([...entry.choices!.map(choice => ({
          id: choice.value, label: choice.label, description: entry.description, currentValue: '', values: [''],
          change: async () => { if (await this.change(entry, choice.value)) done(); },
        })), ...(entry.edit ? [{ id: 'custom-value', label: 'Custom value…', description: entry.description, currentValue: entry.currentValue, edit: true,
          change: async (value: string) => { if (await this.change(entry, value)) done(); else throw new Error(this.error); },
        }] : [])], theme, renderRequested, done, entry.currentValue) }
        : entry.edit ? { submenu: (_value: string, done: () => void) => {
          const input = new Input(); input.setValue(entry.currentValue === 'not set' ? '' : entry.currentValue); input.focused = true;
          input.onSubmit = value => { void this.change(entry, value).then(saved => { if (saved) done(); }); };
          input.onEscape = done;
          return { render: (width: number) => [...new Text(entry.label, 1, 1).render(width), ...input.render(width)],
            handleInput: (data: string) => input.handleInput(data), invalidate: () => input.invalidate() };
        } } : {}),
    }));
    this.list = new SettingsList(items, 12, {
      label: (text, selected) => theme().fg(selected ? 'accent' : 'text', text),
      value: (text, selected) => theme().fg(selected ? 'accent' : 'muted', text),
      description: text => theme().fg('dim', text), cursor: theme().fg('accent', '→ '), hint: text => theme().fg('dim', text),
    }, (id, value) => { void this.change(entries.find(entry => entry.id === id)!, value); }, close, { enableSearch: true });
    if (selected) this.list.selectItem(selected);
  }

  private async change(entry: SettingsEntry, value: string): Promise<boolean> {
    this.pending = true; this.error = ''; this.renderRequested();
    try {
      const saved = await entry.change?.(value);
      entry.currentValue = saved ?? value;
      return true;
    } catch (error) {
      this.error = stripTerminalSequences(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      this.list.updateValue(entry.id, stripTerminalSequences(entry.currentValue));
      this.pending = false; this.renderRequested();
    }
  }

  render(width: number): string[] {
    return [...this.list.render(width), ...(this.pending || this.error
      ? new Text(this.theme().fg(this.error ? 'error' : 'muted', this.error || 'Saving…'), 1, 0).render(width) : [])];
  }
  handleInput(data: string): void { if (!this.pending) this.list.handleInput(data); this.renderRequested(); }
  invalidate(): void { this.list.invalidate(); }
}
