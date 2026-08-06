export const TASK_STATUS_VALUES = [
  'pending',
  'in_progress',
  'blocked',
  'completed',
  'cancelled',
] as const;

export const TASK_VIEW_VALUES = [
  'current',
  'ready',
  'active',
  'blocked',
  'pending',
  'completed',
  'all',
] as const;

export type TaskStatus = typeof TASK_STATUS_VALUES[number];
export type TaskView = typeof TASK_VIEW_VALUES[number];
export type TaskAvailability =
  | 'ready'
  | 'waiting'
  | 'in_progress'
  | 'blocked'
  | 'completed'
  | 'cancelled';

export interface Task {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly acceptanceCriteria?: string;
  readonly priority: number;
  readonly status: TaskStatus;
  readonly blockedBy: readonly string[];
  readonly ownerSessionId?: string;
  readonly claimedAt?: string;
  readonly notes?: string;
  readonly result?: string;
  readonly blockedReason?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
}

export interface TaskState {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly tasks: readonly Task[];
}

export interface CreateTaskInput {
  readonly title: string;
  readonly description?: string;
  readonly acceptanceCriteria?: string;
  readonly priority?: number;
  readonly blockedBy?: readonly string[];
}

export interface UpdateTaskInput {
  readonly taskId: string;
  readonly force?: boolean;
  readonly title?: string;
  readonly description?: string;
  readonly acceptanceCriteria?: string;
  readonly priority?: number;
  readonly status?: TaskStatus;
  readonly addBlockedBy?: readonly string[];
  readonly removeBlockedBy?: readonly string[];
  readonly notes?: string;
  readonly result?: string;
  readonly blockedReason?: string;
}

export interface TaskMutationResult {
  readonly state: TaskState;
  readonly task: Task;
}

export interface TaskCounts {
  readonly total: number;
  readonly ready: number;
  readonly active: number;
  readonly blocked: number;
  readonly pending: number;
  readonly completed: number;
  readonly cancelled: number;
}
