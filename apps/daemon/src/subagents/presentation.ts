import type { FelanExtensionAPI } from '@felan-ai/agent-core';
import type { LocalSubagentHost } from './host.js';

export type LocalSubagentNavigatorHost = Pick<LocalSubagentHost, 'cancel' | 'getLocalSubagent' | 'listLocalSubagents' | 'steer'>
  & Partial<Pick<LocalSubagentHost, 'subscribe' | 'subscribeUsage'>>;
export type AgentRailRenderer = (width: number) => string[];
export interface LocalSubagentNavigatorOptions {
  readonly renderRailInEditor?: () => boolean;
  readonly onRailRendererChange?: (renderer: AgentRailRenderer | undefined) => void;
}
export interface LocalSubagentPresentationHost {
  register(pi: Pick<FelanExtensionAPI, 'on' | 'registerCommand' | 'registerMessageRenderer' | 'registerShortcut'>,
    host: LocalSubagentNavigatorHost, options: LocalSubagentNavigatorOptions): void;
}
