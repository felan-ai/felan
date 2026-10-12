import type { ExtensionContext, ToolDefinition } from '@felan-ai/agent-core';
import type { TasksDisplayMode } from './config.js';
import type { TaskState } from './contracts.js';

export interface TaskDataSource {
  snapshot(): Promise<TaskState>;
  subscribe(listener: (state: TaskState) => void): () => void;
}

export interface TasksPresentationHost {
  readonly renderCalls?: Partial<Record<'TaskCreate' | 'TaskUpdate' | 'TaskList' | 'TaskGet', NonNullable<ToolDefinition['renderCall']>>>;
  show(ui: ExtensionContext['ui'], source: TaskDataSource, displayMode: TasksDisplayMode, signal: AbortSignal): Promise<void>;
}
