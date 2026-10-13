import type { AgentSession, FelanExtensionAPI } from '@felan-ai/agent-core';
import type { Execution } from '@felan-ai/session-protocol';

type Message = AgentSession['messages'][number];
export interface AgentViewTranscript {
  agentId: string;
  cwd: string;
  messages: Message[];
  streaming?: Message;
  pendingTools: string[];
  tools?: Array<{ id: string; state: 'running' | 'completed' | 'failed' | 'interrupted'; output: string; truncated: boolean }>;
  compactions?: Array<{ message: number; method: 'Classifier' | 'Summary' | 'Native' }>;
  fallbacks?: Array<{ before: number; text: string }>;
  streamingText?: string;
  result?: string;
  settings: { hideThinking: boolean; showImages: boolean; imageWidthCells: number; outputPad: number; toolMode: 'grouped' | 'full' };
}

export interface LocalSubagentView extends Execution {
  readonly liveSession?: AgentSession;
}
export type LocalSubagentNavigatorHost = {
  cancel(id: string, reason?: string): Promise<NavigatorResult>;
  steer(id: string, message: string): Promise<NavigatorResult>;
  listLocalSubagents(): readonly LocalSubagentView[];
  getLocalSubagent(id: string): LocalSubagentView | undefined;
  subscribe?(listener: () => void): () => void;
  subscribeUsage?(listener: () => void): () => void;
};
type NavigatorResult = { readonly ok: true; readonly value: Execution }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };
export type AgentRailRenderer = (width: number) => string[];
export interface LocalSubagentNavigatorOptions { readonly renderRailInEditor?: () => boolean; readonly onRailRendererChange?: (renderer: AgentRailRenderer | undefined) => void }
export interface LocalSubagentPresentationHost {
  register(pi: Pick<FelanExtensionAPI, 'on' | 'registerCommand' | 'registerMessageRenderer' | 'registerShortcut'>,
    host: LocalSubagentNavigatorHost, options: LocalSubagentNavigatorOptions): void;
}
