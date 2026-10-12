import type { ExtensionContext } from '@felan-ai/agent-core';
import { Type } from 'typebox';

export const PREWALK_PLAN_LIMIT = 32_000;
export const PREWALK_REVIEW_PRESENTER = Object.freeze({ id: 'felan.prewalk.plan-review', version: '1' });
export const APPROVE_PLAN_OPTION = 'Approve plan';
export const FEEDBACK_PLAN_OPTION = 'Provide feedback';
export const CANCEL_PREWALK_OPTION = 'Cancel Prewalk';
export const PLAN_REVIEW_OPTIONS = [APPROVE_PLAN_OPTION, FEEDBACK_PLAN_OPTION, CANCEL_PREWALK_OPTION] as const;
export type PlanReviewAction = (typeof PLAN_REVIEW_OPTIONS)[number];
export const PlanReviewRequestSchema = Type.Object({ plan: Type.String({ minLength: 1, maxLength: PREWALK_PLAN_LIMIT }) }, { additionalProperties: false });
export const PlanReviewResultSchema = Type.Union([
  Type.Object({ action: Type.Literal(APPROVE_PLAN_OPTION) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal(CANCEL_PREWALK_OPTION) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal(FEEDBACK_PLAN_OPTION), feedback: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
]);

export interface PlanReviewResult {
  action: PlanReviewAction;
  feedback?: string;
}

export interface PrewalkHost {
  review(context: Pick<ExtensionContext, 'ui' | 'mode'>, plan: string, signal?: AbortSignal): Promise<PlanReviewResult | undefined>;
}

export async function reviewPlanWithDialogs(
  context: Pick<ExtensionContext, 'ui'>,
  plan: string,
  signal?: AbortSignal,
): Promise<PlanReviewResult | undefined> {
  const action = await context.ui.select(`Review Prewalk plan\n\n${plan}`, [...PLAN_REVIEW_OPTIONS], signal ? { signal } : undefined);
  return PLAN_REVIEW_OPTIONS.some(option => option === action) ? { action: action as PlanReviewAction } : undefined;
}
