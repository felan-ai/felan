import { decodeUiMarkdown, uiText } from '../../client/ui.js';
import type { ExtensionContext, UiFormAnswer, UiForm } from '@felan-ai/agent-core';
import { presentPrewalkPlan } from './prewalk/plan-review.js';
import { APPROVE_PLAN_OPTION, CANCEL_PREWALK_OPTION, FEEDBACK_PLAN_OPTION, type PlanReviewResult } from '@felan-ai/ext-prewalk/data';
export * from './prewalk/plan-review.js';
export { PREWALK_FORM_HINT } from '@felan-ai/ext-prewalk/data';

export async function presentPrewalkForm(form: UiForm, ui: Pick<ExtensionContext['ui'], 'custom' | 'select'>, signal: AbortSignal): Promise<UiFormAnswer | undefined> {
  if (signal.aborted) return undefined;
  if (form.input.fields.length === 0 && form.markdown === undefined) {
    const enter = form.actions.find(action => action.id === 'enter' && action.outcome === 'submit');
    const cancel = form.actions.find(action => action.id === 'cancel' && action.outcome === 'cancel');
    if (!enter || !cancel || form.actions.length !== 2) throw new Error('Invalid Prewalk entry form.');
    const actions = [enter, cancel];
    const labels = actions.map(action => uiText(action.label));
    const selected = await ui.select([form.title, form.description].filter((value): value is string => !!value).map(uiText).join('\n\n'), labels, { signal });
    if (signal.aborted || selected === undefined) return undefined;
    const action = actions[labels.indexOf(selected)];
    if (!action) throw new Error('Unknown Prewalk entry action.');
    return { kind: 'form', actionId: action.id, outcome: action.outcome, values: {} };
  }
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
