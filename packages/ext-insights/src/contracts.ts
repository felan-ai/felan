import type { AgentRuntime } from '@felan-ai/agent-core';
import type { FacetModelClient } from './facets.js';
import type { Analytics, InsightsSavingsReport } from './types.js';

export interface InsightsSessionReference {
  readonly id: string;
  readonly path: string;
  readonly size: number;
  readonly modifiedAtMs: number;
}

export interface InsightsHost {
  readonly listSessions: (runtime: AgentRuntime) => Promise<readonly InsightsSessionReference[]>;
  readonly readSession: (runtime: AgentRuntime, reference: InsightsSessionReference) => Promise<string | undefined>;
  readonly writeReport: (runtime: AgentRuntime, fileName: string, content: string) => Promise<string>;
  readonly openReport?: (runtime: AgentRuntime, reportPath: string) => Promise<void>;
  readonly writeMarkdown?: (runtime: AgentRuntime, fileName: string, content: string) => Promise<string>;
  readonly modelClient?: (runtime: AgentRuntime) => FacetModelClient | undefined;
  readonly enrichAnalytics?: (analytics: Analytics, runtime: AgentRuntime) => Promise<Analytics>;
  readonly savings?: (runtime: AgentRuntime, analytics: Analytics) => Promise<InsightsSavingsReport | undefined>;
}
