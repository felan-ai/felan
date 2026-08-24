export const CONTROL_MESSAGE_PREFIX = 'pi-prewalk:';
export const PLANNING_MESSAGE_TYPE = `${CONTROL_MESSAGE_PREFIX}planning`;
export const IMPLEMENTATION_MESSAGE_TYPE = `${CONTROL_MESSAGE_PREFIX}implementation`;
export const CONTINUATION_MESSAGE_TYPE = `${CONTROL_MESSAGE_PREFIX}continuation`;
export const MAX_AUTOMATIC_CONTINUATIONS = 3;

export const CONTINUATION_INSTRUCTION = `Continue from the existing findings and task progress without repeating prior analysis. Take the next required tool action and proceed toward the focused mutation.`;

export const PLANNING_INSTRUCTION = `Explore the repository thoroughly and determine the complete work required for the user's request.

Follow this order:
1. Inspect the relevant source, tests, configuration, documentation, and constraints.
2. Determine the full implementation scope, affected files and symbols, risks, and verification required.
3. Use TaskCreate to record a concise graph of no more than 9 outcome-oriented tasks. Put concrete validation in each task's acceptance criteria, using a dedicated validation task only when it covers multiple changes. Link tasks with blocked_by dependencies that encode the required implementation and validation order, so the next ready task is unambiguous at each step.
4. Use TaskUpdate to claim the first ready task by setting it in_progress.
5. Start implementing immediately with one focused change. Work through ready tasks in dependency order, keep task statuses current, record verified results when completing them, and continue until the request is complete.

Keep the implementation focused on the requested scope and revise the task graph when repository evidence changes the plan.`;

export const VERIFICATION_INSTRUCTION = `Continue implementing the existing session task graph. Honor task dependencies, claim ready work with TaskUpdate, keep statuses current, and complete every remaining task with a verified result. Keep the changes limited to the requested scope, run the full relevant test module or suite, resolve failures, and continue until every task is complete.`;
