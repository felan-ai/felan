export const CONTROL_MESSAGE_PREFIX = 'pi-prewalk:';
export const PLANNING_MESSAGE_TYPE = `${CONTROL_MESSAGE_PREFIX}planning`;
export const IMPLEMENTATION_MESSAGE_TYPE = `${CONTROL_MESSAGE_PREFIX}implementation`;
export const CONTINUATION_MESSAGE_TYPE = `${CONTROL_MESSAGE_PREFIX}continuation`;
export const MAX_AUTOMATIC_CONTINUATIONS = 3;

export const PLANNING_INSTRUCTION = `Explore the repository thoroughly and determine the complete work required for the user's request.

Follow this order:
1. Inspect the relevant source, tests, configuration, documentation, and constraints.
2. Determine the full implementation scope, affected files and symbols, risks, and verification required.
3. Call todo_write with 5-9 detailed implementation tasks in execution order. Include validation work and mark exactly one ready task in_progress.
4. Start implementing immediately. Work through the checklist in order, keep task statuses current, run the relevant validation, and continue until the request is complete.

Keep the implementation focused on the requested scope and revise the checklist when repository evidence changes the plan.`;

export const VERIFICATION_INSTRUCTION = `Continue implementing the existing todo_write checklist in task order. Keep statuses current, complete every remaining item, and keep the changes limited to the requested scope. Run the full relevant test module or suite, resolve failures, and report the verification performed.`;

export const BEADS_PLANNING_INSTRUCTION = `Explore the repository thoroughly and determine the complete work required for the user's request.

Use the beads skill and direct bd CLI commands for task tracking. Track the work with Beads instead of todo_write.

Follow this order:
1. Inspect the relevant source, tests, configuration, documentation, and constraints.
2. Determine the full implementation scope, affected files and symbols, risks, and verification required.
3. Create detailed Beads tasks for all implementation and validation work. Give each task a concrete scope and acceptance criteria, add dependencies that represent the required execution order, and mark the first ready task in_progress.
4. Start implementing immediately. Work through ready Beads while honoring their dependencies, keep task statuses current, validate each completed task, and continue until every task for the request is complete.

Keep the implementation focused on the requested scope and update the Beads graph when repository evidence changes the plan.`;

export const BEADS_VERIFICATION_INSTRUCTION = `Continue implementing the existing Beads task graph. Honor task dependencies, work through ready Beads in execution order, and keep their statuses current with direct bd CLI commands instead of todo_write. Validate and close each completed Bead, keep the changes limited to the requested scope, run the full relevant test module or suite, resolve failures, and continue until every task is complete.`;
