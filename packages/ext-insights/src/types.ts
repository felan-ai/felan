export interface SessionEvent {
  type: string;
  timestamp?: string;
  id?: string;
  parentId?: string;
  [key: string]: unknown;
}

export interface ContentItem {
  type: string;
  text?: string;
  name?: string;
  isError?: boolean;
  input?: unknown;
  args?: unknown;
  arguments?: unknown;
}

export interface TokenUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
}

export interface SessionMessage {
  role: "user" | "assistant" | "tool";
  content?: ContentItem[];
  usage?: TokenUsage;
  model?: string;
  provider?: string;
  api?: string;
  thinkingLevel?: string;
  toolCalls?: Array<{ name?: string; input?: unknown; args?: unknown; arguments?: unknown }>;
  toolResults?: Array<{ name?: string; isError?: boolean }>;
  stopReason?: string;
}

export interface RageHit {
  word: string;
  group: string;
  hour: number;
  model: string;
  msgIndex: number;
}

export interface SessionActivity {
  timestamp: Date;
  userMessageCount?: number;
  assistantMessageCount?: number;
  toolCallCount?: number;
  tokenUsage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  models?: Record<string, { count: number; tokens: number; cost: number }>;
  providers?: Record<string, number>;
  thinkingLevels?: Record<string, number>;
  toolUsage?: Record<string, number>;
  stopReasons?: Record<string, number>;
  toolCallErrors?: number;
  rageHits?: RageHit[];
  metadata?: Partial<Omit<SessionMetadata, "primaryModel" | "avgResponseTimeMs" | "firstResponseTimeMs">>;
}

export interface ParsedSession {
  id: string;
  cwd: string;
  projectName: string;
  startTime: Date;
  endTime: Date;
  duration: number;
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  toolCallCount: number;
  tokenUsage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  models: Record<string, { count: number; tokens: number; cost: number }>;
  providers: Record<string, number>;
  thinkingLevels: Record<string, number>;
  toolUsage: Record<string, number>;
  stopReasons: Record<string, number>;
  toolCallErrors: number;
  hasError: boolean;
  rageHits: RageHit[];
  metadata?: SessionMetadata;
  activity?: SessionActivity[];
  agentSessionCount?: number;
}

export interface InsightsSessionReference {
  readonly id: string;
  readonly path: string;
  readonly size: number;
  readonly modifiedAtMs: number;
  readonly rootSessionId?: string;
  readonly isAgent?: boolean;
}

export interface SessionMetadata {
  primaryModel: string;
  responseTimesMs: number[];
  avgResponseTimeMs: number;
  firstResponseTimeMs?: number;
  activityByHour: Record<string, number>;
  filesMentioned: string[];
  languageCounts: Record<string, number>;
  gitActivity: {
    commits: number;
    pushes: number;
    statusChecks: number;
    diffs: number;
  };
  toolErrorsByName: Record<string, number>;
  userInterruptions: number;
}

export interface DailyStats {
  date: string;
  sessions: number;
  messages: number;
  tokens: number;
  cost: number;
}

export interface ProjectStats {
  name: string;
  sessions: number;
  messages: number;
  tokens: number;
  cost: number;
  duration: number;
}

export interface ModelStats {
  name: string;
  count: number;
  tokens: number;
  cost: number;
  avgDuration: number;
}

export interface RageStats {
  total: number;
  messagesWithSwears: number;
  byModel: { name: string; count: number }[];
  byHour: { hour: number; count: number }[];
  byProject: { name: string; count: number }[];
  topWords: { word: string; group: string; count: number }[];
}

export interface InsightFlag {
  severity: "info" | "warning" | "critical";
  title: string;
  detail: string;
  sessionIds?: string[];
}

export interface TemporalInsights {
  generatedAt: string;
  decayHalfLifeDays?: number;
  decayWeightedActivity?: {
    sessions: number;
    messages: number;
    tokens: number;
    cost: number;
  };
  weekOverWeek?: {
    currentStart: string;
    previousStart: string;
    sessionsDelta: number;
    costDelta: number;
    toolErrorDelta: number;
  };
  trajectory?: {
    cost: "improving" | "worsening" | "stable";
    errors: "improving" | "worsening" | "stable";
  };
  anomalies?: InsightFlag[];
  deterministicFriction?: {
    ongoing: InsightFlag[];
    resolved: InsightFlag[];
  };
}

export interface ModelEfficiencyInsight {
  model: string;
  tokens: number;
  cost: number;
  costPerToken: number;
  costPerMessage: number;
  messages: number;
  sessions: number;
  avgSessionDuration: number;
  toolErrorRate?: number;
}

export interface ModelEfficiencySummary {
  generatedAt: string;
  models: ModelEfficiencyInsight[];
  recommendations: string[];
}

export interface AiSessionFacet {
  sessionId: string;
  goal?: string;
  goalCategories?: string[];
  outcome?: string;
  satisfaction?: "positive" | "neutral" | "negative" | "mixed";
  friction?: string[];
  helpfulness?: string;
  sessionType?: string;
  summary?: string;
}

export interface InsightRecommendation {
  title: string;
  detail: string;
  prompt?: string;
  category?: "try" | "stop" | "workflow" | "model";
}

export interface AiInsights {
  status: "available" | "unavailable" | "partial";
  generatedAt?: string;
  sourceRange?: { start: string; end: string };
  cacheState?: "hit" | "miss" | "mixed" | "skipped";
  unavailableReason?: string;
  facets: AiSessionFacet[];
  recommendations: InsightRecommendation[];
  stopDoing: InsightRecommendation[];
}

export interface DeterministicAnalysis {
  generatedAt: string;
  takeaways: InsightFlag[];
  recommendations: InsightRecommendation[];
  stopDoing: InsightRecommendation[];
}

export interface AnalyticsCacheMetadata {
  root: string;
  refreshed: boolean;
  versions: {
    schema: string;
    parser: string;
    facetPrompt: string;
  };
  sessionMeta: {
    hits: number;
    misses: number;
    writes: number;
    errors: number;
  };
}

export interface ReportExportMetadata {
  generatedAt: string;
  outputFormats: Array<"html" | "markdown">;
  htmlPath?: string;
  markdownPath?: string;
}

export interface InsightsSavingsBucket {
  day: string;
  sessionId: string;
  projectKey: string;
  projectName?: string;
  producerId: string;
  category: string;
  operation?: string;
  basis: string;
  tool?: string;
  techniques?: string[];
  calls: number;
  baselineCostUsd?: number;
  actualCostUsd?: number;
  baselineModel?: string;
  actualModel?: string;
  priceSource: string;
}

export interface InsightsSavingsReport {
  scope: string;
  calls: number;
  baselineCostUsd: number;
  actualCostUsd: number;
  savedCostUsd: number;
  hasUnpricedMeasurements: boolean;
  buckets: InsightsSavingsBucket[];
  diagnostics: string[];
}

export interface Analytics {
  totalSessions: number;
  totalMessages: number;
  totalTokens: number;
  totalCost: number;
  totalDuration: number;
  avgSessionDuration: number;
  avgMessagesPerSession: number;
  dateRange: { start: string; end: string };
  dailyStats: DailyStats[];
  projectStats: ProjectStats[];
  modelStats: ModelStats[];
  topTools: { name: string; count: number }[];
  thinkingLevelDistribution: { name: string; count: number }[];
  stopReasonDistribution: { name: string; count: number }[];
  hourlyDistribution: { hour: number; count: number }[];
  modelSwitchCount: number;
  rageStats: RageStats;
  cache?: AnalyticsCacheMetadata;
  export?: ReportExportMetadata;
  temporal?: TemporalInsights;
  modelEfficiency?: ModelEfficiencySummary;
  analysis?: DeterministicAnalysis;
  ai?: AiInsights;
  sessions: Array<{
    id: string;
    cwd: string;
    projectName: string;
    startTime: string;
    endTime: string;
    duration: number;
    messageCount: number;
    userMessageCount: number;
    assistantMessageCount: number;
    toolCallCount: number;
    tokenUsage: ParsedSession["tokenUsage"];
    cost: ParsedSession["cost"];
    models: ParsedSession["models"];
    providers: ParsedSession["providers"];
    thinkingLevels: ParsedSession["thinkingLevels"];
    toolUsage: ParsedSession["toolUsage"];
    stopReasons: ParsedSession["stopReasons"];
    toolCallErrors: number;
    hasError: boolean;
    rageHits: ParsedSession["rageHits"];
    metadata?: ParsedSession["metadata"];
    activity?: Array<Omit<SessionActivity, "timestamp"> & { timestamp: string }>;
    agentSessionCount?: number;
  }>;
  savings?: InsightsSavingsReport;
}
