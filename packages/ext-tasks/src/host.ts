import type { CreateTaskInput, TaskMutationResult, TaskState, UpdateTaskInput } from './contracts.js';

export interface TaskDataSource {
  snapshot(): Promise<TaskState>;
  subscribe(listener: (state: TaskState) => void): () => void;
}

export interface TaskPresentationMutations {
  create(input: CreateTaskInput, signal: AbortSignal): Promise<TaskMutationResult>;
  update(input: UpdateTaskInput, signal: AbortSignal): Promise<TaskMutationResult>;
}
