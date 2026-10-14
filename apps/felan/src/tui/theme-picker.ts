import type { Theme } from '@earendil-works/pi-coding-agent';
import { SelectList, SettingsList, Text, type Component, type SelectItem } from '@earendil-works/pi-tui';
import { clientSelectListTheme } from './theme.js';

export class ThemePicker implements Component {
  private component!: Component;
  private light: string;
  private dark: string;
  private readonly names: string[];

  constructor(names: string[], current: string, private readonly theme: () => Theme,
    private readonly preview: (value: string | undefined) => void, private readonly save: (value: string) => void,
    private readonly cancel: () => void, private readonly changed: () => void) {
    this.names = [...names].sort((a, b) => a === 'system' ? -1 : b === 'system' ? 1 : a.localeCompare(b));
    const [light, dark] = current.split('/');
    this.light = light!; this.dark = dark ?? light!;
    if (dark) this.automatic(); else this.single(current);
  }

  private select(title: string, description: string, items: SelectItem[], selected: string,
    choose: (value: string) => void, cancel: () => void, preview: (value: string) => void): Component {
    const list = new SelectList(items, Math.min(items.length, 10), clientSelectListTheme(this.theme),
      { minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 32 });
    const index = items.findIndex(item => item.value === selected);
    if (index >= 0) list.setSelectedIndex(index);
    list.onSelect = item => choose(item.value); list.onCancel = cancel;
    list.onSelectionChange = item => preview(item.value);
    const heading = new Text(this.theme().fg('accent', this.theme().bold(title)), 0, 0);
    const descriptionText = new Text(this.theme().fg('muted', description), 0, 0);
    const hint = new Text(this.theme().fg('dim', '  Enter to select · Esc to go back'), 0, 0);
    return {
      render: width => [...heading.render(width), '', ...descriptionText.render(width), '', ...list.render(width), '', ...hint.render(width)],
      invalidate: () => list.invalidate(), handleInput: data => list.handleInput(data),
    };
  }

  private items(current: string): SelectItem[] {
    return this.names.map(name => ({ value: name, label: `${name === current ? '✓' : ' '} ${name}`,
      ...(name === 'system' ? { description: "Theme created from your terminal's colors" } : {}) }));
  }

  private single(selected: string): void {
    const items = this.items(selected);
    items.splice(items[0]?.value === 'system' ? 1 : 0, 0, { value: 'automatic', label: '  automatic',
      description: 'Use separate themes for light and dark terminal appearance' });
    this.component = this.select('Theme', 'Select a theme, or choose automatic to follow terminal appearance.', items, selected,
      value => { if (value === 'automatic') { this.preview(this.pair()); this.automatic(); } else this.save(value); },
      this.cancel, value => this.preview(value === 'automatic' ? this.pair() : value));
  }

  private pair(): string { return `${this.light}/${this.dark}`; }

  private automatic(): void {
    const fields = (['light', 'dark'] as const).map(mode => ({ id: mode, label: `${mode === 'light' ? 'Light' : 'Dark'} theme`,
      description: `Theme to use in automatic mode when the terminal is ${mode}`, currentValue: this[mode],
      submenu: (_value: string, done: (value?: string) => void) => this.select(`${mode === 'light' ? 'Light' : 'Dark'} Theme`,
        `Select the theme to use for ${mode} terminal appearance`, this.items(this[mode]), this[mode],
        value => { this[mode] = value; this.preview(this.pair()); done(value); },
        () => { this.preview(this.pair()); done(); }, value => this.preview(value)),
    }));
    const list = new SettingsList([...fields,
      { id: 'apply', label: 'Apply', description: 'Save and go back', currentValue: 'save and go back', values: ['save and go back'] },
      { id: 'single', label: 'Change mode', description: 'Switch to one theme for light and dark', currentValue: 'switch to single theme', values: ['switch to single theme'] },
    ], 4, {
      label: (text, selected) => this.theme().fg(selected ? 'accent' : 'text', text),
      value: (text, selected) => this.theme().fg(selected ? 'accent' : 'muted', text),
      description: text => this.theme().fg('dim', text), cursor: this.theme().fg('accent', '→ '), hint: text => this.theme().fg('dim', text),
    }, id => {
      if (id === 'apply') this.save(this.pair());
      if (id === 'single') { const name = this.theme().appearance === 'light' ? this.light : this.dark; this.preview(name); this.single(name); }
    }, this.cancel);
    this.component = {
      render: width => [...new Text(this.theme().fg('accent', this.theme().bold('Automatic Theme')), 0, 0).render(width), '',
        ...new Text(this.theme().fg('muted', 'Choose themes for terminal light and dark appearance.\nLight/dark detection requires terminal support.'), 0, 0).render(width), '', ...list.render(width)],
      invalidate: () => list.invalidate(), handleInput: data => list.handleInput(data),
    };
  }

  render(width: number): string[] { return this.component.render(width); }
  invalidate(): void { this.component.invalidate(); }
  handleInput(data: string): void { this.component.handleInput?.(data); this.changed(); }
}
