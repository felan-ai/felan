import {
  StringEnum,
  type ExtensionContext,
  type FelanExtension,
} from '@felan-ai/agent-core';
import { Key, Text } from '@earendil-works/pi-tui';
import { Type, type Static } from 'typebox';
import {
  TASK_STATUS_VALUES,
  TASK_VIEW_VALUES,
  type CreateTaskInput,
  type TaskState,
  type UpdateTaskInput,
} from './contracts.js';
import { hasOpenTasks } from './graph.js';
import {
  formatTaskContext,
  formatTaskDetails,
  formatTaskList,
  formatTaskMutation,
} from './presentation.js';
import { TaskStore } from './store.js';
import { TasksOverlay } from './ui/tasks-overlay.js';

const TaskId = Type.String({
  pattern: '^T-[A-Z0-9]{6}$',
  description: 'Stable task ID returned by TaskCreate',
});

const Dependencies = Type.Array(TaskId, {
  maxItems: 32,
  uniqueItems: true,
  description: 'Hard prerequisite task IDs; every prerequisite must complete before this task is ready',
});

const TaskCreateParams = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 200, description: 'Short outcome-oriented task title' }),
  description: Type.Optional(Type.String({ minLength: 1, maxLength: 4_000 })),
  acceptance_criteria: Type.Optional(Type.String({
    minLength: 1,
    maxLength: 4_000,
    description: 'Observable conditions required before completion',
  })),
  priority: Type.Optional(Type.Integer({
    minimum: 0,
    maximum: 4,
    default: 2,
    description: 'Priority from 0 (highest) to 4 (lowest). Default: 2.',
  })),
  blocked_by: Type.Optional(Dependencies),
}, { additionalProperties: false });

const TaskUpdateParams = Type.Object({
  task_id: TaskId,
  force: Type.Optional(Type.Boolean({
    description: 'Explicitly recover or reassign a task claimed by another session. Use only for stale claims.',
  })),
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  description: Type.Optional(Type.String({ minLength: 1, maxLength: 4_000 })),
  acceptance_criteria: Type.Optional(Type.String({ minLength: 1, maxLength: 4_000 })),
  priority: Type.Optional(Type.Integer({ minimum: 0, maximum: 4 })),
  status: Type.Optional(StringEnum(TASK_STATUS_VALUES, {
    description: 'Setting in_progress atomically claims the task for this session',
  })),
  add_blocked_by: Type.Optional(Dependencies),
  remove_blocked_by: Type.Optional(Dependencies),
  notes: Type.Optional(Type.String({
    minLength: 1,
    maxLength: 8_000,
    description: 'Current handoff context, decisions, blocker, and next action',
  })),
  result: Type.Optional(Type.String({
    minLength: 1,
    maxLength: 8_000,
    description: 'Verified completion result; required with completed status',
  })),
  blocked_reason: Type.Optional(Type.String({
    minLength: 1,
    maxLength: 2_000,
    description: 'External blocker; required with blocked status',
  })),
}, { additionalProperties: false });

const TaskListParams = Type.Object({
  view: Type.Optional(StringEnum(TASK_VIEW_VALUES, {
    description: 'Task view. Default: current.',
  })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 50 })),
}, { additionalProperties: false });

const TaskGetParams = Type.Object({ task_id: TaskId }, { additionalProperties: false });

type TaskCreateParams = Static<typeof TaskCreateParams>;
type TaskUpdateParams = Static<typeof TaskUpdateParams>;
type TaskListParams = Static<typeof TaskListParams>;
type TaskGetParams = Static<typeof TaskGetParams>;

const tasksExtension: FelanExtension = (pi) => {
  const store = new TaskStore(pi.runtime);
  let controlsRegistered = false;
  let unsubscribe: (() => void) | undefined;
  let statusContext: ExtensionContext | undefined;
  const overlays = new Set<TasksOverlay>();

  pi.registerCapability({
    id: 'tasks',
    instructions: 'Use session tasks for multi-step, dependency-heavy, or delegated work where explicit progress improves execution. Skip them for trivial requests. Create outcome-oriented tasks with true prerequisite edges, claim a ready task by setting it in_progress before working, keep at most one active task per session, and complete it only after satisfying its acceptance criteria and recording a verified result. Independent sessions may claim different ready tasks concurrently. Record concise notes before blocking or releasing work. Use a persistent issue tracker when work must outlive this root session.',
  });

  pi.registerTool({
    name: 'TaskCreate',
    label: 'TaskCreate',
    description: 'Create one pending task in the root session task graph and return its stable ID. Use blocked_by only for true hard prerequisites.',
    promptSnippet: 'Create a dependency-aware session task',
    parameters: TaskCreateParams,
    async execute(_id, params: TaskCreateParams) {
      const input: CreateTaskInput = {
        title: params.title,
        ...(params.description === undefined ? {} : { description: params.description }),
        ...(params.acceptance_criteria === undefined
          ? {}
          : { acceptanceCriteria: params.acceptance_criteria }),
        ...(params.priority === undefined ? {} : { priority: params.priority }),
        ...(params.blocked_by === undefined ? {} : { blockedBy: params.blocked_by }),
      };
      const result = await store.create(input);
      return {
        content: [{ type: 'text', text: formatTaskMutation('Created', result.state, result.task) }],
        details: { revision: result.state.revision, task: result.task },
      };
    },
    renderCall(args, theme) {
      return new Text(
        theme.fg('toolTitle', theme.bold('TaskCreate ')) + theme.fg('muted', args.title),
        0,
        0,
      );
    },
  });

  pi.registerTool({
    name: 'TaskUpdate',
    label: 'TaskUpdate',
    description: 'Incrementally edit a task, change prerequisites, or transition its lifecycle. Setting in_progress claims a ready task for the calling session. Completion requires ownership and a verified result. Use force only to recover a stale claim.',
    promptSnippet: 'Claim, update, block, release, complete, or cancel a session task',
    parameters: TaskUpdateParams,
    async execute(_id, params: TaskUpdateParams, _signal, _update, ctx) {
      const input: UpdateTaskInput = {
        taskId: params.task_id,
        ...(params.force === undefined ? {} : { force: params.force }),
        ...(params.title === undefined ? {} : { title: params.title }),
        ...(params.description === undefined ? {} : { description: params.description }),
        ...(params.acceptance_criteria === undefined
          ? {}
          : { acceptanceCriteria: params.acceptance_criteria }),
        ...(params.priority === undefined ? {} : { priority: params.priority }),
        ...(params.status === undefined ? {} : { status: params.status }),
        ...(params.add_blocked_by === undefined ? {} : { addBlockedBy: params.add_blocked_by }),
        ...(params.remove_blocked_by === undefined
          ? {}
          : { removeBlockedBy: params.remove_blocked_by }),
        ...(params.notes === undefined ? {} : { notes: params.notes }),
        ...(params.result === undefined ? {} : { result: params.result }),
        ...(params.blocked_reason === undefined ? {} : { blockedReason: params.blocked_reason }),
      };
      const result = await store.update(input, ctx.sessionManager.getSessionId());
      return {
        content: [{ type: 'text', text: formatTaskMutation('Updated', result.state, result.task) }],
        details: { revision: result.state.revision, task: result.task },
      };
    },
    renderCall(args, theme) {
      const status = args.status ? theme.fg('muted', ` → ${args.status}`) : '';
      return new Text(theme.fg('toolTitle', theme.bold(`TaskUpdate ${args.task_id}`)) + status, 0, 0);
    },
  });

  pi.registerTool({
    name: 'TaskList',
    label: 'TaskList',
    description: 'List the current task frontier or filter by readiness and lifecycle state. The default current view excludes terminal tasks.',
    promptSnippet: 'List ready, active, blocked, pending, completed, or all session tasks',
    parameters: TaskListParams,
    async execute(_id, params: TaskListParams) {
      const view = params.view ?? 'current';
      const limit = params.limit ?? 50;
      const result = await store.list(view);
      return {
        content: [{ type: 'text', text: formatTaskList(result.state, result.tasks, view, limit) }],
        details: {
          revision: result.state.revision,
          tasks: result.tasks.slice(0, limit),
          total: result.tasks.length,
          view,
        },
      };
    },
    renderCall(args, theme) {
      return new Text(
        theme.fg('toolTitle', theme.bold('TaskList ')) + theme.fg('muted', args.view ?? 'current'),
        0,
        0,
      );
    },
  });

  pi.registerTool({
    name: 'TaskGet',
    label: 'TaskGet',
    description: 'Read one task with its prerequisites, dependents, ownership, notes, and result.',
    promptSnippet: 'Read full context for one session task',
    parameters: TaskGetParams,
    async execute(_id, params: TaskGetParams) {
      const result = await store.get(params.task_id);
      return {
        content: [{ type: 'text', text: formatTaskDetails(result.state, result.task) }],
        details: { revision: result.state.revision, task: result.task },
      };
    },
    renderCall(args, theme) {
      return new Text(theme.fg('toolTitle', theme.bold(`TaskGet ${args.task_id}`)), 0, 0);
    },
  });

  const setStatus = (state: TaskState): void => {
    if (!statusContext) return;
    if (state.tasks.length === 0) {
      statusContext.ui.setStatus('tasks', undefined);
      return;
    }
    let notStarted = 0;
    let inProgress = 0;
    let done = 0;
    for (const task of state.tasks) {
      if (task.status === 'pending' || task.status === 'blocked') notStarted += 1;
      if (task.status === 'in_progress') inProgress += 1;
      if (task.status === 'completed') done += 1;
    }
    statusContext.ui.setStatus(
      'tasks',
      `Tasks ${notStarted} · ${inProgress} · ${done}`,
    );
  };

  const openOverlay = async (ctx: ExtensionContext): Promise<void> => {
    if (ctx.mode !== 'tui') return;
    await ctx.ui.custom<void>(
      (tui, theme, _keybindings, done) => {
        let overlay!: TasksOverlay;
        overlay = new TasksOverlay(
          store,
          theme,
          () => done(undefined),
          () => tui.requestRender(),
          () => overlays.delete(overlay),
        );
        overlays.add(overlay);
        return overlay;
      },
      {
        overlay: true,
        overlayOptions: {
          width: '85%',
          minWidth: 72,
          maxHeight: '90%',
          margin: 2,
        },
      },
    );
  };

  const registerControls = (): void => {
    if (controlsRegistered) return;
    controlsRegistered = true;
    pi.registerCommand('tasks', {
      description: 'View session tasks and their dependency graph',
      handler: async (_args, ctx) => openOverlay(ctx),
    });
    pi.registerShortcut(Key.ctrlShift('t'), {
      description: 'View session tasks and their dependency graph',
      handler: openOverlay,
    });
  };

  pi.on('session_start', async (_event, ctx) => {
    unsubscribe?.();
    statusContext = ctx.mode === 'tui' ? ctx : undefined;
    unsubscribe = store.subscribe(setStatus);
    setStatus(await store.snapshot());
    if (ctx.mode === 'tui') registerControls();
  });

  pi.on('session_tree', async (_event, ctx) => {
    statusContext = ctx.mode === 'tui' ? ctx : undefined;
    setStatus(await store.snapshot());
  });

  pi.on('before_agent_start', async (event) => {
    const state = await store.snapshot();
    if (!hasOpenTasks(state)) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${formatTaskContext(state)}` };
  });

  pi.on('session_shutdown', () => {
    for (const overlay of overlays) overlay.dispose();
    overlays.clear();
    unsubscribe?.();
    unsubscribe = undefined;
    statusContext?.ui.setStatus('tasks', undefined);
    statusContext = undefined;
    store.close();
  });
};

export type {
  CreateTaskInput,
  Task,
  TaskAvailability,
  TaskCounts,
  TaskMutationResult,
  TaskState,
  TaskStatus,
  TaskView,
  UpdateTaskInput,
} from './contracts.js';
export {
  TaskGraphError,
  cloneTaskState,
  createTask,
  emptyTaskState,
  getTask,
  hasOpenTasks,
  incompleteBlockers,
  listTasks,
  parseTaskState,
  taskAvailability,
  taskCounts,
  taskDependents,
  updateTask,
} from './graph.js';
export { TaskStore } from './store.js';
export default tasksExtension;
