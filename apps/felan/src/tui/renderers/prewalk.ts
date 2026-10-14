import { decodeUiMarkdown } from '../../client/ui.js';
import type { ExtensionContext, UiFormAnswer, UiForm } from '@felan-ai/agent-core';
import { presentPrewalkPlan } from './prewalk/plan-review.js';
import { APPROVE_PLAN_OPTION, CANCEL_PREWALK_OPTION, FEEDBACK_PLAN_OPTION, type PlanReviewResult } from '@felan-ai/ext-prewalk/data';
export * from './prewalk/plan-review.js';
export { PREWALK_FORM_HINT } from '@felan-ai/ext-prewalk/data';

export async function presentPrewalkForm(form: UiForm, ui: Pick<ExtensionContext['ui'], 'custom'>, signal: AbortSignal): Promise<UiFormAnswer | undefined> {
  const answer = (result: PlanReviewResult): UiFormAnswer => {
    const action = form.actions.find(action => action.label === result.action);
    if (!action) throw new Error('Prewalk form is missing its response action.');
    return { kind: 'form', actionId: action.id, outcome: action.outcome,
      values: result.action === FEEDBACK_PLAN_OPTION ? { feedback: result.feedback ?? '' } : {} };
  };
  const field = form.input.fields.find(field => field.id === 'feedback');
  if (!form.markdown || field?.kind !== 'string'
    || ![APPROVE_PLAN_OPTION, FEEDBACK_PLAN_OPTION, CANCEL_PREWALK_OPTION].every(label => form.actions.some(action => action.label === label))) {
    throw new Error('Invalid Prewalk review form.');
  }
  const result = await presentPrewalkPlan(ui, decodeUiMarkdown(form.markdown), signal, result => {
    const value = answer(result);
    return typeof value.values.feedback === 'string' && new TextEncoder().encode(value.values.feedback).length > field.maxLength
      ? 'This response is too large. Shorten the feedback and try again.' : undefined;
  });
  return signal.aborted || result === undefined ? undefined : answer(result);
}
