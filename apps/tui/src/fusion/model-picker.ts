import { fuzzyFilter, getKeybindings, Input, Key, matchesKey, truncateToWidth, visibleWidth, type Component, type Focusable } from '@earendil-works/pi-tui';
import type { FusionModelChoice } from '@felan-ai/ext-fusion';
import type { Theme } from '@felan-ai/agent-core';

export interface FusionModelPickerResult {
  readonly participants: readonly string[];
  readonly fusionModel: string;
}

export interface FusionModelPickerOptions {
  readonly models: readonly FusionModelChoice[];
  readonly participants: readonly string[];
  readonly fusionModel: string;
  readonly allowInherit?: boolean;
  readonly allowParticipants?: boolean;
  readonly initialMode?: 'participants' | 'fusion';
  readonly minParticipants?: number;
  readonly maxParticipants?: number;
}

export class FusionModelPicker implements Component, Focusable {
  readonly searchInput = new Input({ placeholder: 'Search model name or provider/model…' });
  private readonly models: readonly FusionModelChoice[];
  private readonly byReference: ReadonlyMap<string, FusionModelChoice>;
  private readonly selectedParticipants: string[];
  private fusionModel: string;
  private mode: 'participants' | 'fusion';
  private filtered: FusionModelChoice[];
  private selectedIndex = 0;
  private hasFocus = false;
  private closed = false;

  constructor(
    private readonly options: FusionModelPickerOptions,
    private readonly theme: Theme,
    private readonly done: (result: FusionModelPickerResult | undefined) => void,
    private readonly requestRender: () => void = () => {},
  ) {
    const unavailable = [...new Set(options.participants)].filter((reference) => !options.models.some((model) => model.reference === reference));
    this.models = [
      ...(options.allowInherit === false ? [] : [{ reference: 'inherit', label: 'Inherit current chat model' }]),
      ...unavailable.map((reference) => ({ reference, label: `Unavailable: ${cleanLabel(reference)}` })),
      ...options.models,
    ].sort((left, right) => left.reference.localeCompare(right.reference));
    this.byReference = new Map(this.models.map((model) => [model.reference, model]));
    this.selectedParticipants = [...new Set(options.participants)];
    this.fusionModel = options.fusionModel;
    this.mode = options.allowParticipants === false ? 'fusion' : options.initialMode ?? 'participants';
    this.filtered = this.modelsForMode();
    this.searchInput.focused = true;
  }

  get focused(): boolean { return this.hasFocus; }
  set focused(value: boolean) {
    this.hasFocus = value;
    this.searchInput.focused = value;
  }

  handleInput(data: string): void {
    if (this.closed) return;
    const keys = getKeybindings();
    if (matchesKey(data, Key.escape) || keys.matches(data, 'tui.select.cancel')) {
      this.closed = true;
      this.done(undefined);
    } else if (keys.matches(data, 'app.models.save') || matchesKey(data, Key.ctrl('s'))) {
      if (this.isValid()) {
        this.closed = true;
        this.done({ participants: [...this.selectedParticipants], fusionModel: this.fusionModel });
      }
    } else if (matchesKey(data, Key.tab)) {
      if (this.options.allowParticipants !== false) {
        this.mode = this.mode === 'participants' ? 'fusion' : 'participants';
        this.filter();
      }
      this.requestRender();
    } else if (keys.matches(data, 'tui.select.up') || matchesKey(data, Key.up)) {
      this.moveSelection(-1);
    } else if (keys.matches(data, 'tui.select.down') || matchesKey(data, Key.down)) {
      this.moveSelection(1);
    } else if (keys.matches(data, 'tui.select.confirm') || matchesKey(data, Key.enter)) {
      this.chooseCurrent();
    } else {
      this.searchInput.handleInput(data);
      this.filter();
    }
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    const narrow = safeWidth < 84;
    const mainWidth = narrow ? safeWidth : Math.max(36, Math.floor(safeWidth * 0.62));
    const summaryWidth = narrow ? safeWidth : safeWidth - mainWidth - 3;
    const left = this.renderMain(mainWidth);
    if (narrow) return [...left, '', ...this.renderSummary(safeWidth)].map((line) => fit(line, safeWidth));
    const right = this.renderSummary(summaryWidth);
    const height = Math.max(left.length, right.length);
    return Array.from({ length: height }, (_, index) =>
      `${pad(left[index] ?? '', mainWidth)} │ ${pad(right[index] ?? '', summaryWidth)}`,
    ).map((line) => fit(line, safeWidth));
  }

  invalidate(): void { this.searchInput.invalidate(); }

  private renderMain(width: number): string[] {
    const lines = [
      this.theme.fg('accent', this.theme.bold(`Fusion model selection · ${this.mode === 'participants' ? 'Participants' : 'Comparison / Fusion'}`)),
      this.mode === 'participants' ? 'Enter toggle · Tab fusion model · Ctrl+S save · Esc cancel' : this.options.allowParticipants === false ? 'Enter choose model · Ctrl+S select · Esc cancel' : 'Enter choose model · Tab participants · Ctrl+S save · Esc cancel',
      ...this.searchInput.render(width),
    ];
    const maxRows = width < 54 ? 5 : 9;
    const start = Math.max(0, Math.min(this.selectedIndex - 3, this.filtered.length - maxRows));
    for (let index = start; index < Math.min(start + maxRows, this.filtered.length); index++) {
      const model = this.filtered[index]!;
      const selected = this.selectedParticipants.includes(model.reference);
      const active = index === this.selectedIndex;
      const chosenFusion = model.reference === this.fusionModel;
      const status = this.mode === 'participants' ? (selected ? '✓' : ' ') : (chosenFusion ? '◆' : ' ');
      lines.push(`${active ? '→' : ' '} ${status} ${cleanLabel(model.label)}`);
    }
    if (this.filtered.length === 0) {
      lines.push('No matching models');
    }
    if (this.filtered.length > maxRows) lines.push(`(${this.selectedIndex + 1}/${this.filtered.length})`);
    if (this.selectedParticipants.some((reference) => !this.isAvailable(reference)) || (this.fusionModel !== 'inherit' && !this.isAvailable(this.fusionModel))) {
      lines.push('Unavailable saved model choices must be replaced before saving.');
    }
    return lines.map((line) => fit(line, width));
  }

  private renderSummary(width: number): string[] {
    const available = this.selectedParticipants.filter((reference) => this.isAvailable(reference));
    const lines = [
      this.theme.fg('accent', this.theme.bold(`Selected participants (${available.length}/${this.options.maxParticipants ?? 8})`)),
      ...this.selectedParticipants.map((reference, index) => `${index + 1}. ${cleanLabel(this.byReference.get(reference)?.label ?? `Unavailable: ${reference}`)}`),
      '',
      this.theme.fg('accent', this.theme.bold('Comparison / Fusion model')),
      this.fusionModel === 'inherit'
        ? (this.options.allowInherit === false ? 'No model selected' : 'Inherit current chat model')
        : cleanLabel(this.byReference.get(this.fusionModel)?.label ?? `Unavailable: ${this.fusionModel}`),
      '',
      this.validationMessage(),
    ];
    return lines.map((line) => fit(line, width));
  }

  private filter(): void {
    const query = this.searchInput.getValue();
    const models = this.modelsForMode();
    this.filtered = query ? fuzzyFilter(models, query, ({ reference, label }) => `${reference} ${label}`) : models;
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filtered.length - 1));
    this.requestRender();
  }

  private moveSelection(delta: number): void {
    if (this.filtered.length === 0) return;
    this.selectedIndex = (this.selectedIndex + delta + this.filtered.length) % this.filtered.length;
    this.requestRender();
  }

  private chooseCurrent(): void {
    if (this.mode === 'fusion' && this.filtered[this.selectedIndex]?.reference === 'inherit') {
      this.fusionModel = 'inherit';
      this.requestRender();
      return;
    }
    const model = this.filtered[this.selectedIndex];
    if (!model) return;
    if (this.mode === 'fusion') {
      this.fusionModel = model.reference;
    } else {
      if (model.reference === 'inherit') return;
      const index = this.selectedParticipants.indexOf(model.reference);
      if (index >= 0) this.selectedParticipants.splice(index, 1);
      else if (this.selectedParticipants.length < (this.options.maxParticipants ?? 8)) this.selectedParticipants.push(model.reference);
    }
    this.requestRender();
  }

  private isValid(): boolean {
    const maximum = this.options.maxParticipants ?? 8;
    const validParticipants = this.options.allowParticipants === false
      || (this.selectedParticipants.length >= (this.options.minParticipants ?? 2)
        && this.selectedParticipants.length <= maximum
        && this.selectedParticipants.every((reference) => this.isAvailable(reference)));
    return validParticipants
      && (this.fusionModel === 'inherit' ? this.options.allowInherit !== false : this.isAvailable(this.fusionModel));
  }

  private validationMessage(): string {
    if (this.options.allowParticipants !== false && this.selectedParticipants.some((reference) => !this.isAvailable(reference))) return 'Remove or replace unavailable participants.';
    const minimum = this.options.minParticipants ?? 2;
    if (this.options.allowParticipants !== false && this.selectedParticipants.length < minimum) return `Select at least ${minimum} participants.`;
    if (this.selectedParticipants.length > (this.options.maxParticipants ?? 8)) return `Select no more than ${this.options.maxParticipants ?? 8} participants.`;
    if (this.fusionModel === 'inherit' && this.options.allowInherit === false) return 'Choose a comparison / fusion model.';
    if (this.fusionModel !== 'inherit' && !this.isAvailable(this.fusionModel)) return 'Choose an available comparison / fusion model.';
    return 'Ready to save';
  }

  private isAvailable(reference: string): boolean {
    return reference !== 'inherit' && this.options.models.some((model) => model.reference === reference);
  }

  private modelsForMode(): FusionModelChoice[] {
    return this.mode === 'fusion' ? [...this.models] : this.models.filter((model) => model.reference !== 'inherit');
  }
}

function fit(value: string, width: number): string {
  const safe = Math.max(1, width);
  return visibleWidth(value) <= safe ? value : truncateToWidth(value, safe, '…', true);
}

function pad(value: string, width: number): string {
  const fitted = fit(value, width);
  return fitted + ' '.repeat(Math.max(0, width - visibleWidth(fitted)));
}

function cleanLabel(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '').replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ');
}
