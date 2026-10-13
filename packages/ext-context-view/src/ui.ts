import { CONTEXT_DOCUMENT_HINT } from './data.js';
import type { ExtensionUi, UiDocument, UiElementHandle } from '@felan-ai/agent-core';
import { CATEGORY_SUMMARIES, type ContextReport, type ContextViewPresentationHost } from './report.js';


export function createContextViewUiHost(ui: ExtensionUi): ContextViewPresentationHost {
  let sequence = 0;
  return {
    async show(report, signal) {
      signal.throwIfAborted();
      const document: UiDocument = {
        id: `context-report-${++sequence}`, kind: 'document', revision: 1,
        hint: CONTEXT_DOCUMENT_HINT,
        title: 'Context usage', markdown: reportMarkdown(report),
        fallback: 'Full context usage report with token estimates and all available detail rows.',
        actions: [{ id: 'close', label: 'Close report', target: 'element', outcome: 'cancel' }],
      };
      if (new TextEncoder().encode(JSON.stringify(document)).length > 256 * 1024) {
        throw new Error('Context report exceeds the UI document byte limit; no report content was omitted.');
      }
      let handle: UiElementHandle | undefined;
      let closeRequested = false;
      let closeWork: Promise<void> | undefined;
      let closeError: unknown;
      let resolveClosed!: () => void;
      const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
      const close = async (): Promise<void> => {
        closeRequested = true;
        if (!handle) return;
        closeWork ??= Promise.resolve().then(() => handle!.close())
          .then(resolveClosed, error => { closeError = error; resolveClosed(); });
        await closeWork;
      };
      const abort = () => { void close(); };
      signal.addEventListener('abort', abort, { once: true });
      try {
        handle = await ui.present(document, {
          signal,
          onAction: async action => {
            if (action.elementId !== document.id || action.revision !== document.revision
              || action.actionId !== 'close' || action.outcome !== 'cancel'
              || action.itemId !== undefined || Object.keys(action.values).length !== 0) {
              throw new Error('Invalid context report action.');
            }
            await close();
          },
        });
        if (signal.aborted || closeRequested) await close();
        await closed;
        if (closeError !== undefined) throw closeError;
      } finally {
        signal.removeEventListener('abort', abort);
      }
    },
  };
}

function reportMarkdown(report: ContextReport): string {
  if (report.extensionDetailsTotal !== undefined && report.extensionDetailsTotal !== report.extensionDetails.length
    || report.skillDetailsTotal !== undefined && report.skillDetailsTotal !== report.skillDetails.length) {
    throw new Error('A full context report requires every extension and skill detail row.');
  }
  return [
    `Model: ${cell(report.modelLabel ?? 'unknown')}`,
    `Usage: ${report.usedTokens} / ${report.contextWindow ?? 'unknown'} tokens`,
    `Usage percent: ${report.usagePercent === null ? 'unknown' : `${report.usagePercent}%`}`,
    `Measurements: ${report.estimated ? 'estimates, not provider billing measurements' : 'reported values'}`,
    '', '| Category | Tokens |', '| --- | ---: |',
    ...CATEGORY_SUMMARIES.map(({ key, label }) => `| ${label} | ${report.breakdown[key]} |`),
    '', '## Counts',
    `- System tools: ${report.systemToolCount}`,
    `- Extension tools: ${report.extensionToolCount}`,
    `- Context files: ${report.contextFileCount}`,
    `- Skills: ${report.skillCount}`,
    '', '## Memory', '| Component | Tokens |', '| --- | ---: |',
    ...(['summary', 'index', 'schema', 'recalls'] as const).map(key => `| ${key} | ${report.memory[key]} |`),
    '', `## Extensions (${report.extensionDetails.length})`, '| Extension | Tools | Tokens |', '| --- | ---: | ---: |',
    ...report.extensionDetails.map(row => `| ${cell(row.label)} | ${row.toolCount} | ${row.tokens} |`),
    '', `## Skills (${report.skillDetails.length})`, '| Skill | Tokens | Included in prompt |', '| --- | ---: | --- |',
    ...report.skillDetails.map(row => `| ${cell(row.label)} | ${row.tokens} | ${row.promptVisible ? 'yes' : 'no'} |`),
  ].join('\n');
}

function cell(value: string): string {
  return value.replace(/[\\`*_{}()#+.!|~]/gu, '\\$&')
    .replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
    .replace(/\[/gu, '&#91;').replace(/\]/gu, '&#93;')
    .replace(/[\u0000-\u001f\u007f-\u009f]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu,
      character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export { CONTEXT_DOCUMENT_HINT } from './data.js';
