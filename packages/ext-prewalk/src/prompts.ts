export const CONTROL_MESSAGE_PREFIX = 'pi-prewalk:';
export const PLANNING_MESSAGE_TYPE = `${CONTROL_MESSAGE_PREFIX}planning`;
export const IMPLEMENTATION_MESSAGE_TYPE = `${CONTROL_MESSAGE_PREFIX}implementation`;
export const PLAN_REVIEW_MESSAGE_TYPE = `${CONTROL_MESSAGE_PREFIX}plan-review`;
export const PLAN_APPROVED_MESSAGE_TYPE = `${CONTROL_MESSAGE_PREFIX}plan-approved`;
export const CONTINUATION_MESSAGE_TYPE = `${CONTROL_MESSAGE_PREFIX}continuation`;
export const MAX_AUTOMATIC_CONTINUATIONS = 3;

export const CONTINUATION_INSTRUCTION = `Continue from the existing findings and task progress without repeating prior analysis. Take the next required tool action and follow the current phase guidance.`;

export const PLANNING_INSTRUCTION = `Determine the complete work required for the user's request. Build on findings already in the conversation and inspect only what is still missing.

Follow this order:
1. Inspect the relevant source, tests, configuration, documentation, and constraints that the conversation does not already cover.
2. Determine the full implementation scope, affected files and symbols, risks, and verification required.
3. Use TaskCreate to record a concise graph of no more than 9 outcome-oriented tasks. Put concrete validation in each task's acceptance criteria, using a dedicated validation task only when it covers multiple changes. Link tasks with blocked_by dependencies that encode the required implementation and validation order, so the next ready task is unambiguous at each step.
4. Use TaskUpdate to claim the first ready task by setting it in_progress.
5. Start implementing immediately with one focused change. Work through ready tasks in dependency order, keep task statuses current, record verified results when completing them, and continue until the request is complete.

Keep the implementation focused on the requested scope and revise the task graph when repository evidence changes the plan.`;

export const PLAN_REVIEW_PLANNING_INSTRUCTION = `Determine the complete work required for the user's request without modifying the repository. Build on findings already in the conversation and inspect only what is still missing.

Follow this order:
1. Inspect the relevant source, tests, configuration, documentation, and constraints that the conversation does not already cover.
2. Determine the full implementation scope, affected files and symbols, risks, and verification required.
3. Use TaskCreate to record a concise graph of no more than 9 outcome-oriented tasks. Put concrete validation in each task's acceptance criteria, using a dedicated validation task only when it covers multiple changes. Link tasks with blocked_by dependencies that encode the required implementation and validation order, so the next ready task is unambiguous at each step.
4. Use TaskUpdate to claim the first ready task by setting it in_progress.
5. Call exit_plan_mode with the concise numbered plan as its plan argument. Call it as the only tool in the response and do not print the plan separately. The tool will present the plan and collect approval, feedback, or cancellation. Do not edit files or otherwise mutate the repository before approval.

Keep the plan focused on the requested scope and revise the task graph when repository evidence changes the plan.`;

export const PLAN_APPROVED_INSTRUCTION = `The user approved the plan supplied to exit_plan_mode. Continue from the claimed task and make one focused repository mutation that establishes the implementation direction. Keep the task graph current and proceed with the approved scope.`;

const IMPLEMENTATION_BASE = `Continue implementing the existing session task graph. Honor task dependencies, claim ready work with TaskUpdate, keep statuses current, and complete every remaining task with a verified result. Keep the changes limited to the requested scope, run the full relevant test module or suite, resolve failures, and continue until every task is complete.`;

const REVIEWER_REQUEST = `launch one Agent with subagent_type reviewer at the high tier. Ask it to compare the complete change with the user's request, the approved plan, and the task acceptance criteria, and to report incorrect or unverified behavior, fabricated results, skipped scope, security issues, and regressions. Give it the changed files, the diff command, and the verification commands you ran. Do not claim the work is complete while the review is pending; end with a short status that names the pending review. The review completion notice resumes the session so its findings can be resolved.`;

export const VERIFICATION_INSTRUCTION = `${IMPLEMENTATION_BASE}

Prewalk requires an independent review of the implementation. After every task is complete and verification passes, ${REVIEWER_REQUEST}`;

export const GATED_VERIFICATION_INSTRUCTION = `${IMPLEMENTATION_BASE}

When every task is complete and verification passes, finish with a concise summary of the changes and the verification commands with their results. An automatic completion check then decides whether more work or an independent review is needed, so do not launch a reviewer unless the user asked for one.`;

export const COMPLETION_MESSAGE_TYPE = 'prewalk-completion-check';

export const COMPLETION_GAP_INSTRUCTION = `The automatic completion check found that the request is not fully satisfied. Compare the result with the user's request, the approved plan, and every task's acceptance criteria; complete any missing or unverified work, run the relevant verification after the last change, and finish with a concise summary of the changes and verification results.`;

export const COMPLETION_REVIEW_INSTRUCTION = `The automatic completion check could not confirm that the work is complete. To decide, ${REVIEWER_REQUEST}`;

export const ENTRY_MESSAGE_TYPE = `${CONTROL_MESSAGE_PREFIX}entry`;

export const ENTRY_GUIDANCE = `This request is complex repository work that benefits from Prewalk. Call \`enter_prewalk\` as the only tool call in your next response, before exploring or changing files. If entry is declined, continue on the regular path.`;

export const EXPLORATION_DEPTH_GUIDANCE = {
  sufficient: `Exploration depth: sufficient. The conversation already covers what this plan needs. Plan from those findings, do not re-explore, and inspect only the specific facts you will change.`,
  targeted: `Exploration depth: targeted. Inspect the specific missing files and symbols yourself; do not launch discovery subagents.`,
  deep: `Exploration depth: deep. The relevant surface is broad and largely unexplored. Delegate discovery to \`explore\` children with bounded, disjoint, read-only questions and a requested summary format. While they run, do not read the delegated scopes yourself; yield until their completion notices arrive. Then verify the facts you rely on and inspect the critical-path files yourself.`,
} as const;
