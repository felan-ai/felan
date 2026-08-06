import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { AgentRuntime, AgentRuntimeStorage } from '@felan-ai/agent-core';
import type {
  CreateTaskInput,
  Task,
  TaskMutationResult,
  TaskState,
  TaskView,
  UpdateTaskInput,
} from './contracts.js';
import {
  cloneTaskState,
  createTask,
  emptyTaskState,
  getTask,
  listTasks,
  parseTaskState,
  TASK_ID_PATTERN,
  updateTask,
} from './graph.js';

interface SharedTaskStore {
  readonly directory: string;
  readonly statePath: string;
  readonly listeners: Set<(state: TaskState) => void>;
  control: Promise<void>;
  refs: number;
  state?: TaskState;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const stores = new Map<string, SharedTaskStore>();

export class TaskStore {
  readonly root: string;
  readonly statePath: string;
  readonly #key: string;
  readonly #storage: AgentRuntimeStorage;
  readonly #shared: SharedTaskStore;
  readonly #listeners = new Set<(state: TaskState) => void>();
  #closed = false;

  constructor(runtime: AgentRuntime) {
    const storage = runtime.storage('session');
    this.#storage = storage;
    this.#key = `${runtime.kind}\0${storage.root}`;
    this.root = join(storage.root, 'tasks');
    this.statePath = join(this.root, 'state.json');
    const existing = stores.get(this.#key);
    this.#shared = existing ?? {
      directory: this.root,
      statePath: this.statePath,
      listeners: new Set(),
      control: Promise.resolve(),
      refs: 0,
    };
    if (!existing) stores.set(this.#key, this.#shared);
    this.#shared.refs += 1;
  }

  async snapshot(): Promise<TaskState> {
    return this.#run(async () => {
      const state = await readState(this.#storage, this.#shared);
      this.#replaceState(state);
      return cloneTaskState(state);
    });
  }

  async create(input: CreateTaskInput): Promise<TaskMutationResult> {
    return this.#run(async () => {
      const current = await readState(this.#storage, this.#shared);
      let id = generateTaskId();
      while (current.tasks.some((task) => task.id === id)) id = generateTaskId();
      const result = createTask(current, input, id, new Date().toISOString());
      await writeState(this.#storage, this.#shared, result.state);
      this.#replaceState(result.state, true);
      return cloneMutation(result);
    });
  }

  async update(input: UpdateTaskInput, actorSessionId: string): Promise<TaskMutationResult> {
    return this.#run(async () => {
      const current = await readState(this.#storage, this.#shared);
      const result = updateTask(current, input, actorSessionId, new Date().toISOString());
      await writeState(this.#storage, this.#shared, result.state);
      this.#replaceState(result.state, true);
      return cloneMutation(result);
    });
  }

  async get(id: string): Promise<{ state: TaskState; task: Task }> {
    const state = await this.snapshot();
    return { state, task: getTask(state, id) };
  }

  async list(view: TaskView): Promise<{ state: TaskState; tasks: Task[] }> {
    const state = await this.snapshot();
    return { state, tasks: listTasks(state, view) };
  }

  subscribe(listener: (state: TaskState) => void): () => void {
    this.#assertOpen();
    this.#listeners.add(listener);
    this.#shared.listeners.add(listener);
    if (this.#shared.state) notify(listener, this.#shared.state);
    return () => {
      this.#listeners.delete(listener);
      this.#shared.listeners.delete(listener);
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const listener of this.#listeners) this.#shared.listeners.delete(listener);
    this.#listeners.clear();
    this.#shared.refs -= 1;
    if (this.#shared.refs === 0 && stores.get(this.#key) === this.#shared) stores.delete(this.#key);
  }

  async #run<T>(operation: () => Promise<T>): Promise<T> {
    this.#assertOpen();
    const previous = this.#shared.control;
    let release!: () => void;
    this.#shared.control = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      this.#assertOpen();
      return await operation();
    } finally {
      release();
    }
  }

  #replaceState(state: TaskState, alwaysNotify = false): void {
    const changed = this.#shared.state?.revision !== state.revision;
    this.#shared.state = cloneTaskState(state);
    if (!alwaysNotify && !changed) return;
    for (const listener of this.#shared.listeners) notify(listener, state);
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('Task store is closed');
  }
}

async function readState(storage: AgentRuntimeStorage, shared: SharedTaskStore): Promise<TaskState> {
  let bytes: Uint8Array;
  try {
    bytes = await storage.readFile(shared.statePath);
  } catch (error) {
    if (isNotFoundError(error)) return emptyTaskState();
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(bytes));
  } catch {
    throw new Error(`Task state is not valid JSON: ${shared.statePath}`);
  }
  return parseTaskState(value);
}

async function writeState(
  storage: AgentRuntimeStorage,
  shared: SharedTaskStore,
  state: TaskState,
): Promise<void> {
  await storage.mkdir(shared.directory, { recursive: true });
  await storage.writeFile(
    shared.statePath,
    encoder.encode(`${JSON.stringify(state, null, 2)}\n`),
  );
}

function notify(listener: (state: TaskState) => void, state: TaskState): void {
  try {
    listener(cloneTaskState(state));
  } catch {
    // Presentation listeners cannot roll back an already persisted mutation.
  }
}

function generateTaskId(): string {
  const id = `T-${randomBytes(3).toString('hex').toUpperCase()}`;
  if (!TASK_ID_PATTERN.test(id)) throw new Error('Generated an invalid task id');
  return id;
}

function cloneMutation(result: TaskMutationResult): TaskMutationResult {
  const state = cloneTaskState(result.state);
  return { state, task: getTask(state, result.task.id) };
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && (
    ('code' in error && error.code === 'ENOENT')
    || /(?:not found|does not exist|no such file)/iu.test(error.message)
  );
}
