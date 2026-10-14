import { stripVTControlCharacters } from 'node:util';
import {
  parseUiForm, parseUiPresentation, validateUiAction, validateUiFormAnswer,
  type UiActionRequest, type UiFormAnswer, type UiForm,
  type UiInput, type UiPresentation, type UiValues, type UiAction, type UiStatus,
} from '@felan-ai/session-protocol';
import type { UiHintRenderers } from './hint-renderers.js';

export const GENERIC_UI_CAPABILITIES = ['ui.document', 'ui.view', 'ui.progress', 'ui.status', 'ui.action'] as const;

export interface GenericUiDriver {
  choose(message: string, options: readonly { id: string; label: string }[], signal: AbortSignal): Promise<string | undefined>;
  fields(message: string, input: UiInput, signal: AbortSignal): Promise<UiValues | undefined>;
  display(message: string, signal: AbortSignal): Promise<void>;
}

export function uiCapability(value: UiPresentation): typeof GENERIC_UI_CAPABILITIES[number] {
  switch (value.kind) {
    case 'document': return 'ui.document';
    case 'view': return 'ui.view';
    case 'progress': return 'ui.progress';
    case 'status': return 'ui.status';
  }
}

export function uiText(value: string): string {
  return stripVTControlCharacters(value).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, '');
}

export function decodeUiMarkdown(value: string, options: { plainText?: boolean } = {}): string {
  const markdown = options.plainText ? value.replace(/\\([\\`*_{}\[\]()#+.!|~\-])/gu, '$1') : value;
  return markdown.replace(/&(?:amp|lt|gt|quot|apos|#(?:x[\da-f]+|\d+));/giu, entity => {
    const named: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
    const decoded = named[entity.toLowerCase()];
    if (decoded !== undefined) return decoded;
    const hexadecimal = entity[2]?.toLowerCase() === 'x';
    const code = Number.parseInt(entity.slice(hexadecimal ? 3 : 2, -1), hexadecimal ? 16 : 10);
    return code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : entity;
  });
}

function literal(value: string): string {
  return uiText(value).replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/[\\`*_{}\[\]()#+.!|~\-]/gu, '\\$&');
}

export function formText(form: UiForm): string {
  return [literal(form.title), form.description && literal(form.description), form.markdown && uiText(form.markdown), literal(form.fallback)].filter(Boolean).join('\n\n');
}

export function statusText(source: UiStatus): string {
  const value = source.value;
  if (value.kind === 'text') return uiText(value.text);
  const text = value.kind === 'money' ? `${value.value} ${value.currency}`
    : value.kind === 'duration' ? `${value.milliseconds} ms` : `${value.value}${value.kind === 'percent' ? '%' : ' tokens'}`;
  return uiText(`${source.key}: ${text}`);
}

export function presentationText(value: UiPresentation): string {
  const source = parseUiPresentation(value);
  switch (source.kind) {
    case 'document': return `${literal(source.title)}\n\n${uiText(source.markdown)}`;
    case 'view': return [literal(source.title), ...source.items.map(item => [
      `### ${literal(item.id)}`, ...source.fields.map(field => `${literal(field.label)}: ${literal(String(item.values[field.id] ?? ''))}`),
    ].join('\n'))].join('\n\n');
    case 'progress': return `${literal(source.label)}: ${source.state}${source.fraction === undefined ? '' : ` (${Math.round(source.fraction * 100)}%)`}`;
    case 'status': return literal(statusText(source));
  }
}

export async function presentUiForm(value: UiForm, driver: GenericUiDriver, signal: AbortSignal, hints?: UiHintRenderers): Promise<UiFormAnswer | undefined> {
  const form = parseUiForm(value);
  if (signal.aborted) return undefined;
  const renderer = hints?.get(form.hint)?.form;
  if (renderer) {
    const answer = await renderer(structuredClone(form), signal);
    return signal.aborted || answer === undefined ? undefined : validateUiFormAnswer(form, answer);
  }
  const id = await driver.choose(formText(form), form.actions.map(action => ({ id: action.id, label: uiText(action.label) })), signal);
  if (signal.aborted || id === undefined) return undefined;
  const action = form.actions.find(action => action.id === id);
  if (!action) throw new Error('Unknown form action.');
  const values = action.outcome === 'cancel' ? {} : await driver.fields(uiText(form.title), form.input, signal);
  if (signal.aborted || values === undefined) return undefined;
  return validateUiFormAnswer(form, { kind: 'form', actionId: id, outcome: action.outcome, values });
}

export async function presentUiElement(value: UiPresentation, driver: GenericUiDriver, signal: AbortSignal, interactive = true, hints?: UiHintRenderers, selected?: { actionId: string; itemId?: string }): Promise<UiActionRequest | undefined> {
  const source = parseUiPresentation(value);
  if (signal.aborted) return undefined;
  const renderer = interactive && hints?.get(source.hint)?.presentation;
  if (renderer) {
    const action = await renderer(structuredClone(source), signal);
    if (signal.aborted || action === undefined) return undefined;
    const current = hints!.currentPresentation(source, signal);
    if (current.kind === 'status') throw new Error('Status items cannot return actions.');
    return validateUiAction(current, action);
  }
  const message = presentationText(source);
  if (source.kind === 'status') { await driver.display(message, signal); return undefined; }
  if (!interactive || !source.actions.length) {
    await driver.display(message + (!interactive && source.actions.length ? '\n\nControls unavailable: generic UI actions were not negotiated.' : ''), signal);
    return undefined;
  }
  const choices: Array<{ action: UiAction; itemId?: string; label: string }> = [];
  for (const action of source.actions) {
    if (action.target === 'item' && source.kind === 'view') {
      for (const item of source.items) choices.push({ action, itemId: item.id, label: `${uiText(action.label)} — ${uiText(item.id)}` });
    } else if (action.target === 'element') choices.push({ action, label: uiText(action.label) });
  }
  if (!choices.length) { await driver.display(message, signal); return undefined; }
  const id = selected ? String(choices.findIndex(choice => choice.action.id === selected.actionId && choice.itemId === selected.itemId))
    : await driver.choose(message, choices.map((choice, index) => ({ id: String(index), label: choice.label })), signal);
  if (signal.aborted || id === undefined) return undefined;
  const choice = choices.find((_choice, index) => String(index) === id);
  if (!choice) throw new Error('Unknown presentation action.');
  const input = choice.action.input ?? { fields: [] };
  const defaults = source.kind === 'view' && source.query?.actionId === choice.action.id ? source.query.values : undefined;
  const values = choice.action.outcome === 'cancel' ? {} : await driver.fields(choice.label,
    defaults ? { ...input, defaults: { ...input.defaults, ...defaults } } : input, signal);
  if (signal.aborted || values === undefined) return undefined;
  return validateUiAction(source, { elementId: source.id, revision: source.revision, actionId: choice.action.id,
    outcome: choice.action.outcome, values, ...(choice.itemId === undefined ? {} : { itemId: choice.itemId }) });
}
