import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import type { ModelReference } from '../model-tiers.js';
import type { FelanThinkingLevel } from '../thinking.js';
import { defineServiceContract } from '../services.js';

export interface SessionsRequestOptions {
  readonly signal?: AbortSignal;
}

export interface SessionPageOptions extends SessionsRequestOptions {
  readonly cursor?: string;
  readonly limit?: number;
}

export interface SessionPage<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}

export interface SessionRef {
  readonly id: string;
  readonly root: string;
  readonly parent?: string;
}

export interface SessionHistoryInfo extends SessionRef {
  readonly title: string;
  /** Display metadata in the runtime's path namespace, never a storage selector. */
  readonly cwd: string;
  readonly updatedAt: number;
  readonly state: 'open' | 'closed';
  readonly diagnostic?: 'inaccessible' | 'oversize' | 'unsupported';
}

export interface HistoryRevision {
  readonly sessionId: string;
  /** Content identity, independent of the daemon's control/projection counter. */
  readonly revision: string;
  /** The selected leaf entry ID; history may also contain abandoned branches. */
  readonly branch: string | null;
}

export interface SessionHistoryOptions extends SessionPageOptions {
  readonly at?: HistoryRevision;
}

export interface SessionHistoryPage extends HistoryRevision {
  readonly entries: readonly SessionEntry[];
  /** Original parseable header timestamp, repeated on every page when available. */
  readonly startedAt?: string;
  readonly nextCursor?: string;
}

export interface SessionCheckpointRef extends HistoryRevision {
  /** UTF-8 byte length of the provider's complete source snapshot, before branch selection. */
  readonly byteLength: number;
  /**
   * Lowercase hexadecimal SHA-256 of a compact UTF-8 JSON array, root to selected
   * leaf (empty array for null). Object keys sort by JavaScript string order;
   * primitives use JSON.stringify formatting. Entries must be valid JSON.
   */
  readonly transcriptDigest: string;
}

export interface SessionExecution {
  readonly id: string;
  readonly parent?: string;
  readonly label?: string;
  readonly description?: string;
  readonly createdAt?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly completionPending?: boolean;
  readonly model?: ModelReference;
  readonly usage?: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number; readonly cacheWrite1h: number; readonly cost: number };
  /** Absent until the queued execution has a canonically registered session. */
  readonly session?: SessionRef;
  readonly state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  readonly result?: { readonly text: string; readonly error?: string; readonly truncated: boolean };
}

export interface SessionExecutionInput {
  readonly prompt: string;
  /** Additional instructions; providers must retain the base prompt and project instructions. */
  readonly appendSystemPrompt?: string;
  readonly model?: ModelReference;
  readonly thinking?: FelanThinkingLevel;
  readonly description: string;
  readonly maxTurns?: number;
  readonly timeoutMs?: number;
  readonly label?: string;
  readonly allowChildren?: boolean;
  readonly excludedTools?: readonly string[];
  readonly notifyOnCompletion?: boolean;
}

export interface SessionExecutionsOptions extends SessionPageOptions {
  /** Descendants are visible but only direct children can be controlled. */
  readonly includeDescendants?: boolean;
}

export interface SessionExecutionReadOptions extends SessionsRequestOptions {
  readonly acknowledge?: boolean;
}

export interface SessionsEvent {
  readonly kind: 'history' | 'execution';
  /** A history event identifies a session; an execution event identifies an execution record. */
  readonly id: string;
}

/** Providers must expose a separate frozen facade with only these members. */
export interface SessionsHistory {
  readonly current: SessionRef;
  /** Filters an already authorized inventory; project/cwd equality never grants access. */
  list(filter: { readonly scope: 'root' | 'project' | 'visible' }, options?: SessionPageOptions): Promise<SessionPage<SessionHistoryInfo>>;
  /**
   * Complete, unfiltered Pi entries in append order, parents before children.
   * Entries are untrusted data. Cursors pin session, revision and selected leaf;
   * any changed source or mismatched pin fails with stale, never a mixed page.
   */
  history(id: string, options?: SessionHistoryOptions): Promise<SessionHistoryPage>;
  checkpoint(id: string, options?: SessionsRequestOptions): Promise<SessionCheckpointRef>;
}

export interface SessionsService extends SessionsHistory {
  setTitleIfMissing(title: string, requestId: string, options?: SessionsRequestOptions): Promise<boolean>;
  /** Admission rechecks scope. Invalid or out-of-range requests reject, never clamp. */
  create(input: SessionExecutionInput, options?: SessionsRequestOptions): Promise<SessionExecution>;
  /** Only executions owned by this parent are readable and controllable through this handle. */
  executions(options?: SessionExecutionsOptions): Promise<SessionPage<SessionExecution>>;
  execution(id: string, options?: SessionExecutionReadOptions): Promise<SessionExecution>;
  steer(id: string, message: string, options?: SessionsRequestOptions): Promise<void>;
  cancel(id: string, reason?: string, options?: SessionsRequestOptions): Promise<void>;
  /** Events use the same history and execution visibility as this handle's reads. */
  subscribe(listener: (event: SessionsEvent) => void): () => void;
}

export type SessionsServiceErrorCode = 'invalid' | 'inaccessible' | 'stale' | 'oversize' | 'unsupported';

const messages: Record<SessionsServiceErrorCode, string> = {
  invalid: 'Session request or data is invalid.',
  inaccessible: 'Session operation is inaccessible.',
  stale: 'Session state or snapshot is stale.',
  oversize: 'Session data exceeds its size limit.',
  unsupported: 'Session operation or format is unsupported.',
};

export class SessionsServiceError extends Error {
  readonly code: SessionsServiceErrorCode;

  constructor(code: SessionsServiceErrorCode, message?: string) {
    const safeCode = code === 'inaccessible' || code === 'stale' || code === 'oversize' || code === 'unsupported' ? code : 'invalid';
    super(message ?? messages[safeCode]);
    this.name = 'SessionsServiceError';
    this.code = safeCode;
  }
}

export const SESSION_HISTORY_LIMITS = Object.freeze({
  fileBytes: 64 * 1024 * 1024,
  pageBytes: 12 * 1024 * 1024,
  pageEntries: 256,
});

export const SESSION_EXECUTION_LIMITS = Object.freeze({ maxTurns: 100, timeoutMs: 86_400_000,
  promptBytes: 128 * 1024, appendSystemPromptBytes: 128 * 1024, descriptionBytes: 512,
  steerBytes: 32 * 1024, cancelReasonBytes: 4096, titleBytes: 4096, requestIdBytes: 128,
  resultTextBytes: 64 * 1024, resultErrorBytes: 4096 });

export function createReadOnlySessionsService(source: SessionsHistory): SessionsHistory {
  return Object.freeze({
    current: Object.freeze({ ...source.current }),
    list: source.list.bind(source),
    history: source.history.bind(source),
    checkpoint: source.checkpoint.bind(source),
  });
}

export const SESSIONS_HISTORY_SERVICE = defineServiceContract<SessionsHistory>('felan.sessions.history', 1);
export const SESSIONS_SERVICE = defineServiceContract<SessionsService>('felan.sessions', 1);
