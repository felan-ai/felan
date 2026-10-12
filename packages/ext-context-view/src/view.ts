import { CATEGORY_SUMMARIES, USED_CATEGORIES, type ContextReport } from './report.js';
import type { ContextViewDisplayMode } from './config.js';

export const CONTEXT_VIEW_PRESENTER = Object.freeze({ id: 'felan.context-view', version: '1' });
export const CONTEXT_VIEW_BYTES = 60 * 1024;
export interface ContextViewRequest {
  displayMode: ContextViewDisplayMode;
  report: ContextReport & { extensionDetailsTotal: number; skillDetailsTotal: number };
}
const encoder = new TextEncoder();
const controls = /[\u0000-\u001f\u007f-\u009f]/u;
const counts = ['usedTokens', 'systemToolCount', 'extensionToolCount', 'contextFileCount', 'skillCount', 'extensionDetailsTotal', 'skillDetailsTotal'] as const;
const memory = ['summary', 'index', 'schema', 'recalls'] as const;
function invalid(): never { throw new Error('Invalid context view data.'); }
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some(key => !keys.includes(key))) invalid();
}
function count(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function text(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && !controls.test(value) && encoder.encode(value).length <= maximum
    && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
}
function label(value: string, maximum: number): string {
  const clean = new TextDecoder().decode(encoder.encode(value)).replace(/[\u0000-\u001f\u007f-\u009f]/gu, '');
  if (encoder.encode(clean).length <= maximum) return clean;
  let result = ''; let size = 3;
  for (const char of clean) {
    const bytes = encoder.encode(char).length;
    if (size + bytes > maximum) break;
    result += char; size += bytes;
  }
  return `${result}…`;
}

export function createContextViewRequest(report: ContextReport, displayMode: ContextViewDisplayMode): ContextViewRequest {
  return parseContextViewRequest({ displayMode, report: {
    breakdown: { ...report.breakdown }, usedTokens: report.usedTokens, contextWindow: report.contextWindow,
    usagePercent: report.usagePercent, estimated: report.estimated, systemToolCount: report.systemToolCount,
    extensionToolCount: report.extensionToolCount, contextFileCount: report.contextFileCount, skillCount: report.skillCount,
    memory: { ...report.memory }, modelLabel: report.modelLabel === null ? null : label(report.modelLabel, 2048),
    extensionDetailsTotal: report.extensionDetailsTotal ?? report.extensionDetails.length,
    skillDetailsTotal: report.skillDetailsTotal ?? report.skillDetails.length,
    extensionDetails: report.extensionDetails.slice(0, 8).map(row => ({ label: label(row.label, 512), toolCount: row.toolCount, tokens: row.tokens })),
    skillDetails: report.skillDetails.slice(0, 8).map(row => ({ label: label(row.label, 512), tokens: row.tokens, promptVisible: row.promptVisible })),
  } });
}

export function parseContextViewRequest(value: unknown): ContextViewRequest {
  if (!record(value) || !['inline', 'overlay'].includes(value.displayMode as string) || !record(value.report)) invalid();
  exact(value, ['displayMode', 'report']);
  const report = value.report;
  exact(report, [...counts, 'breakdown', 'contextWindow', 'usagePercent', 'estimated', 'memory', 'modelLabel', 'extensionDetails', 'skillDetails']);
  if (!counts.every(key => count(report[key])) || !record(report.breakdown) || !record(report.memory)
    || report.contextWindow !== null && !count(report.contextWindow) || typeof report.estimated !== 'boolean'
    || report.modelLabel !== null && !text(report.modelLabel, 2048)) invalid();
  const breakdown = report.breakdown;
  exact(breakdown, CATEGORY_SUMMARIES.map(item => item.key));
  if (!CATEGORY_SUMMARIES.every(item => count(breakdown[item.key]))) invalid();
  const used = USED_CATEGORIES.reduce((total, key) => total + (breakdown[key] as number), 0);
  if (!count(used) || used !== report.usedTokens) invalid();
  const available = report.contextWindow === null ? 0 : Math.max(0, (report.contextWindow as number) - used);
  const percent = report.contextWindow ? used / (report.contextWindow as number) * 100 : null;
  if (breakdown.available !== available || report.usagePercent !== percent) invalid();
  const memoryValues = report.memory;
  exact(memoryValues, memory);
  if (!memory.every(key => count(memoryValues[key]))) invalid();
  if (!Array.isArray(report.extensionDetails) || !Array.isArray(report.skillDetails)
    || report.extensionDetails.length !== Math.min(8, report.extensionDetailsTotal as number)
    || report.skillDetails.length !== Math.min(8, report.skillDetailsTotal as number)
    || report.skillDetailsTotal !== report.skillCount) invalid();
  const extensions = report.extensionDetails.map(row => {
    if (!record(row)) invalid(); exact(row, ['label', 'tokens', 'toolCount']);
    if (!text(row.label, 512) || !count(row.tokens) || !count(row.toolCount)) invalid();
    return { label: row.label, tokens: row.tokens, toolCount: row.toolCount };
  });
  if (extensions.reduce((total, row) => total + row.toolCount, 0) > (report.extensionToolCount as number)
    || (report.extensionDetailsTotal as number) > (report.extensionToolCount as number)) invalid();
  const skills = report.skillDetails.map(row => {
    if (!record(row)) invalid(); exact(row, ['label', 'tokens', 'promptVisible']);
    if (!text(row.label, 512) || !count(row.tokens) || typeof row.promptVisible !== 'boolean' || !row.promptVisible && row.tokens !== 0) invalid();
    return { label: row.label, tokens: row.tokens, promptVisible: row.promptVisible };
  });
  if (encoder.encode(JSON.stringify(value)).length > CONTEXT_VIEW_BYTES) invalid();
  return { displayMode: value.displayMode as ContextViewDisplayMode, report: {
    breakdown: {
      systemPrompt: breakdown.systemPrompt as number, systemTools: breakdown.systemTools as number,
      extensions: breakdown.extensions as number, contextFiles: breakdown.contextFiles as number,
      skills: breakdown.skills as number, memory: breakdown.memory as number,
      messages: breakdown.messages as number, other: breakdown.other as number, available,
    },
    usedTokens: used, contextWindow: report.contextWindow, usagePercent: percent, estimated: report.estimated,
    systemToolCount: report.systemToolCount as number, extensionToolCount: report.extensionToolCount as number,
    contextFileCount: report.contextFileCount as number, skillCount: report.skillCount as number,
    extensionDetailsTotal: report.extensionDetailsTotal as number, skillDetailsTotal: report.skillDetailsTotal as number,
    modelLabel: report.modelLabel, extensionDetails: extensions, skillDetails: skills,
    memory: { summary: memoryValues.summary as number, index: memoryValues.index as number,
      schema: memoryValues.schema as number, recalls: memoryValues.recalls as number },
  } };
}

export function parseContextViewResult(value: unknown): { closed: true } {
  if (!record(value) || value.closed !== true) invalid();
  exact(value, ['closed']); return { closed: true };
}
