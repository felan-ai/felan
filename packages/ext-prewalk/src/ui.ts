import { PREWALK_FORM_HINT } from './data.js';
import type { ExtensionUi, UiForm, UiRequestResult } from '@felan-ai/agent-core';
import {
  APPROVE_PLAN_OPTION,
  CANCEL_PREWALK_OPTION,
  FEEDBACK_PLAN_OPTION,
  PREWALK_PLAN_LIMIT,
  type PrewalkHost,
} from './plan-review-contracts.js';

const encoder = new TextEncoder();
const FEEDBACK_BYTES = 16 * 1024;

export function createPrewalkUiHost(ui: ExtensionUi): { host: PrewalkHost; dispose(): Promise<void> } {
  const lifetime = new AbortController();
  const pending = new Set<Promise<UiRequestResult>>();
  const request = (form: UiForm, signal?: AbortSignal): Promise<UiRequestResult> => {
    if ((form.markdown && encoder.encode(form.markdown).length > 128 * 1024)
      || encoder.encode(JSON.stringify(form)).length + 64 * 1024 > 256 * 1024) {
      throw new Error('Prewalk review exceeds the UI form byte limit; no plan content was omitted.');
    }
    const combined = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    const work = (async () => {
      combined.throwIfAborted();
      const result = await ui.request(form, { signal: combined });
      combined.throwIfAborted();
      return result;
    })();
    pending.add(work);
    void work.then(() => pending.delete(work), () => pending.delete(work));
    return work;
  };
  return {
    host: {
      async confirmEntry(_context, description, signal) {
        const result = await request({
          title: 'Enter Prewalk?', description,
          fallback: 'Prewalk entry requires explicit approval.', input: { fields: [] },
          actions: [
            { id: 'enter', label: 'Enter Prewalk', target: 'element', outcome: 'submit' },
            { id: 'cancel', label: 'Continue without Prewalk', target: 'element', outcome: 'cancel' },
          ],
        }, signal);
        return result.state === 'answered' && result.answer.kind === 'form'
          && result.answer.actionId === 'enter' && result.answer.outcome === 'submit';
      },
      async review(_context, plan, signal) {
        if (!plan.trim() || plan.length > PREWALK_PLAN_LIMIT) throw new Error('Invalid Prewalk plan length.');
        const result = await request({
          hint: PREWALK_FORM_HINT,
          title: 'Review Prewalk plan', markdown: displayMarkdown(plan),
          description: 'Approve the complete plan, request changes with feedback, or cancel Prewalk.',
          fallback: 'Review the complete Prewalk plan before approving implementation.',
          input: { fields: [{ id: 'feedback', kind: 'string', label: 'Feedback when requesting changes', required: false, multiline: true, maxLength: FEEDBACK_BYTES }] },
          actions: [
            { id: 'approve', label: APPROVE_PLAN_OPTION, target: 'element', outcome: 'submit' },
            { id: 'feedback', label: FEEDBACK_PLAN_OPTION, target: 'element', outcome: 'submit' },
            { id: 'cancel', label: CANCEL_PREWALK_OPTION, target: 'element', outcome: 'cancel' },
          ],
        }, signal);
        if (result.state !== 'answered' || result.answer.kind !== 'form') return undefined;
        const { actionId, outcome, values } = result.answer;
        if (actionId === 'cancel' && outcome === 'cancel') return { action: CANCEL_PREWALK_OPTION };
        if (outcome !== 'submit') return undefined;
        if (actionId === 'approve') return { action: APPROVE_PLAN_OPTION };
        if (actionId !== 'feedback') return undefined;
        const feedback = values.feedback;
        if (feedback !== undefined && (typeof feedback !== 'string' || encoder.encode(feedback).length > FEEDBACK_BYTES)) {
          throw new Error('Invalid Prewalk feedback.');
        }
        return { action: FEEDBACK_PLAN_OPTION, feedback: feedback ?? '' };
      },
    },
    async dispose() {
      lifetime.abort();
      await Promise.allSettled([...pending]);
    },
  };
}

function displayMarkdown(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
    .replace(/\[/gu, '&#91;').replace(/\]/gu, '&#93;')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu,
      character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}


export { PREWALK_FORM_HINT } from './data.js';
