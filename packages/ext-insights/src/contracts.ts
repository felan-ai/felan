import type { AgentRuntime } from '@felan-ai/agent-core';
import type { InsightsSavingsReport, InsightsSessionReference, ParsedSession, Analytics } from './types.js';

export type { InsightsSessionReference } from './types.js';

export interface InsightsLoadedSession {
  readonly rootId: string;
  readonly session: ParsedSession;
}

export interface InsightsReport {
  readonly path: string;
  readonly generatedAt: Date;
  readonly initialRange: string;
  readonly loaded: readonly InsightsLoadedSession[];
}

export interface InsightsHost {
  readonly listSessions: (runtime: AgentRuntime, signal?: AbortSignal) => Promise<readonly InsightsSessionReference[]>;
  readonly readSession: (runtime: AgentRuntime, reference: InsightsSessionReference, signal?: AbortSignal) => Promise<string | undefined>;
  readonly readSessionLines?: (runtime: AgentRuntime, reference: InsightsSessionReference, signal?: AbortSignal) => AsyncIterable<string>;
  readonly writeReport: (runtime: AgentRuntime, fileName: string, content: string) => Promise<string>;
  readonly presentReport?: (runtime: AgentRuntime, report: InsightsReport, signal?: AbortSignal) => Promise<void>;
  readonly writeMarkdown?: (runtime: AgentRuntime, fileName: string, content: string) => Promise<string>;
  readonly savings?: (runtime: AgentRuntime, analytics: Analytics) => Promise<InsightsSavingsReport | undefined>;
}
