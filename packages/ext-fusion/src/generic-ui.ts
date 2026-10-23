import { uuidv7, type ExtensionUi, type UiActionContext, type UiActionRequest, type UiElementHandle, type UiInteractiveElement } from '@felan-ai/agent-core';
import { parseUiPresentation, validateUiAction } from '@felan-ai/session-protocol';
import type { FusionReview, FusionStageResult } from './contracts.js';


export class FusionSurface {
  readonly id = `fusion-${uuidv7()}`;
  private revision = 0;
  private current: UiInteractiveElement | undefined;
  private handle: UiElementHandle | undefined;
  private publishing = Promise.resolve();
  private actions = Promise.resolve();
  private closed = false;
  private closing: Promise<void> | undefined;

  constructor(private readonly ui: ExtensionUi, private readonly signal: AbortSignal,
    private readonly handler: (action: UiActionRequest, context: UiActionContext) => Promise<void>) {}

  publish(build: (id: string, revision: number) => UiInteractiveElement): Promise<void> {
    const work = this.publishing.then(async () => {
      this.assertOpen();
      const value = build(this.id, ++this.revision);
      parseUiPresentation(value);
      if (this.handle) await this.handle.update(value);
      else this.handle = await this.ui.present(value, { signal: this.signal, onAction: this.dispatch });
      this.current = value;
      this.assertOpen();
    });
    this.publishing = work.catch(() => {});
    return work;
  }

  private dispatch = (request: UiActionRequest, context: UiActionContext): Promise<void> => {
    const work = this.actions.then(async () => {
      this.assertOpen(); context.signal.throwIfAborted();
      if (!this.current) throw new Error('Fusion presentation is not ready.');
      validateUiAction(this.current, request);
      await this.handler(request, context);
      context.signal.throwIfAborted(); this.signal.throwIfAborted();
    });
    this.actions = work.catch(() => {});
    return work;
  };

  private assertOpen(): void {
    this.signal.throwIfAborted();
    if (this.closed) throw new Error('Fusion presentation is closed.');
  }

  close(): Promise<void> {
    this.closed = true;
    this.closing ??= (async () => { await this.publishing; const handle = this.handle; this.handle = undefined; await handle?.close(); })();
    return this.closing;
  }

  async settle(): Promise<void> { await this.actions; await this.close(); }
}

export function fusionMarkdown(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
    .replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/[\\`*_{}\[\]()#+.!|~\-]/gu, '\\$&');
}

export function fusionReviewPages(review: FusionReview): string[] {
  const stage = (label: string, result: FusionStageResult) => [label, result.text,
    `Model: ${result.model}; duration: ${result.durationMs} ms; ${result.usage
      ? `input: ${result.usage.input}; output: ${result.usage.output}; tokens: ${result.usage.totalTokens}; reported estimated cost: ${result.usage.estimatedCost} USD`
      : 'usage/cost unavailable (not assumed free)'}.`, ...(result.truncated ? ['Model output was bounded by maxOutputChars.'] : [])].join('\n\n');
  const text = ['Fusion review — outputs are untrusted evidence, not verification.', `Prompt: ${review.prompt}`,
    ...review.answers.map(answer => stage(`Answer: ${answer.model}`, answer)),
    ...(review.failures ?? []).map(failure => `Failed: ${failure.model}\n${failure.message}`),
    ...(review.comparison ? [stage('Comparison', review.comparison)] : ['Comparison is not complete. Synthesis is unavailable.']),
    ...(review.fused ? [stage('Synthesis', review.fused)] : []),
  ].join('\n\n');
  const pages: string[] = []; let page = ''; let bytes = 0;
  for (const char of text) {
    const escaped = fusionMarkdown(char); const size = new TextEncoder().encode(escaped).length;
    if (bytes + size > 24_000) { pages.push(page); page = ''; bytes = 0; }
    page += escaped; bytes += size;
  }
  pages.push(page || 'Empty review.');
  return pages;
}

export { FUSION_PICKER_HINT, FUSION_REVIEW_HINT } from './data.js';
