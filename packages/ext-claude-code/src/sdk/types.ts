export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type SettingSource = 'user' | 'project' | 'local';

export interface Base64ImageSource {
  type: 'base64';
  media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  data: string;
}

export type ContentBlockParam =
  | { type: 'text'; text: string }
  | { type: 'image'; source: Base64ImageSource };

export interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string | ContentBlockParam[] };
  parent_tool_use_id: string | null;
  priority?: 'now' | 'next' | 'later';
}

export interface SDKMessage {
  type: string;
  subtype?: string;
  result?: string;
}

export interface SdkQuery extends AsyncIterable<SDKMessage> {
  interrupt(): Promise<void>;
  close(): void;
  applyFlagSettings?(settings: { effortLevel?: EffortLevel | null }): Promise<void>;
}

export interface McpRequest {
  params: { name: string; _meta?: Record<string, unknown> };
}

export interface McpServerInstance {
  server: {
    setRequestHandler(schema: unknown, handler: (request: McpRequest) => unknown): void;
  };
}

export interface SdkMcpServer {
  type: 'sdk';
  name: string;
  instance: McpServerInstance;
}

export interface SdkQueryOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  tools?: string[];
  permissionMode?: 'bypassPermissions';
  includePartialMessages?: boolean;
  settings?: {
    autoMemoryEnabled?: boolean;
    claudeMdExcludes?: string[];
    includeGitInstructions?: boolean;
  };
  systemPrompt?: string | { type: 'preset'; preset: 'claude_code'; append?: string };
  extraArgs?: Record<string, string | null>;
  effort?: EffortLevel;
  thinking?: { type: 'disabled' };
  mcpServers?: Record<string, SdkMcpServer>;
  resume?: string;
  pathToClaudeCodeExecutable?: string;
  strictMcpConfig?: boolean;
  settingSources?: SettingSource[];
  skills?: string[];
  persistSession?: boolean;
  model?: string;
  maxTurns?: number;
  debug?: boolean;
  debugFile?: string;
  stderr?: (data: string) => void;
}

export type Query = (request: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: SdkQueryOptions;
}) => SdkQuery;

export interface ClaudeAgentSdk {
  query: Query;
  McpServer: new (
    info: { name: string; version: string },
    options: { capabilities: { tools: Record<string, never> } },
  ) => McpServerInstance;
  CallToolRequestSchema: object;
  ListToolsRequestSchema: object;
}
