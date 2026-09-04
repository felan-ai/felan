export const CONTROL_MESSAGE_PREFIX = 'pi-prewalk:';
export const PLANNING_MESSAGE_TYPE = `${CONTROL_MESSAGE_PREFIX}planning`;
export const IMPLEMENTATION_MESSAGE_TYPE = `${CONTROL_MESSAGE_PREFIX}implementation`;
export const PLAN_REVIEW_MESSAGE_TYPE = `${CONTROL_MESSAGE_PREFIX}plan-review`;
export const PLAN_APPROVED_MESSAGE_TYPE = `${CONTROL_MESSAGE_PREFIX}plan-approved`;
export const CONTINUATION_MESSAGE_TYPE = `${CONTROL_MESSAGE_PREFIX}continuation`;
export const MAX_AUTOMATIC_CONTINUATIONS = 3;

export const CONTINUATION_INSTRUCTION = `Continue from the existing findings and task progress without repeating prior analysis. Take the next required tool action and follow the current phase guidance.`;

export const PLANNING_INSTRUCTION = `Explore the repository thoroughly and determine the complete work required for the user's request.

Follow this order:
1. Inspect the relevant source, tests, configuration, documentation, and constraints.
2. Determine the full implementation scope, affected files and symbols, risks, and verification required.
3. Use TaskCreate to record a concise graph of no more than 9 outcome-oriented tasks. Put concrete validation in each task's acceptance criteria, using a dedicated validation task only when it covers multiple changes. Link tasks with blocked_by dependencies that encode the required implementation and validation order, so the next ready task is unambiguous at each step.
4. Use TaskUpdate to claim the first ready task by setting it in_progress.
5. Start implementing immediately with one focused change. Work through ready tasks in dependency order, keep task statuses current, record verified results when completing them, and continue until the request is complete.

Keep the implementation focused on the requested scope and revise the task graph when repository evidence changes the plan.`;

export const PLAN_REVIEW_PLANNING_INSTRUCTION = `Explore the repository thoroughly and determine the complete work required for the user's request without modifying the repository.

Follow this order:
1. Inspect the relevant source, tests, configuration, documentation, and constraints.
2. Determine the full implementation scope, affected files and symbols, risks, and verification required.
3. Use TaskCreate to record a concise graph of no more than 9 outcome-oriented tasks. Put concrete validation in each task's acceptance criteria, using a dedicated validation task only when it covers multiple changes. Link tasks with blocked_by dependencies that encode the required implementation and validation order, so the next ready task is unambiguous at each step.
4. Use TaskUpdate to claim the first ready task by setting it in_progress.
5. Call exit_plan_mode with the concise numbered plan as its plan argument. Call it as the only tool in the response and do not print the plan separately. The tool will present the plan and collect approval, feedback, or cancellation. Do not edit files or otherwise mutate the repository before approval.

Keep the plan focused on the requested scope and revise the task graph when repository evidence changes the plan.`;

export const PLAN_APPROVED_INSTRUCTION = `The user approved the plan supplied to exit_plan_mode. Continue from the claimed task and make one focused repository mutation that establishes the implementation direction. Keep the task graph current and proceed with the approved scope.`;

export const VERIFICATION_INSTRUCTION = `Continue implementing the existing session task graph. Honor task dependencies, claim ready work with TaskUpdate, keep statuses current, and complete every remaining task with a verified result. Keep the changes limited to the requested scope, run the full relevant test module or suite, resolve failures, and continue until every task is complete.`;
