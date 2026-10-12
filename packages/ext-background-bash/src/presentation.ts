import type { ExtensionContext, FelanExtensionAPI, ToolDefinition } from '@felan-ai/agent-core';
import type { BackgroundBashJob, BackgroundBashStatusFilter } from './job-store.js';

export const BACKGROUND_BASH_COMPLETION_MESSAGE_TYPE = 'felan-background-bash-completion';

export interface BackgroundProcessViewSource {
  list(status: BackgroundBashStatusFilter): Promise<BackgroundBashJob[]>;
  tail(id: string, lines?: number): Promise<string>;
  stop(id: string, signal?: 'SIGTERM' | 'SIGKILL'): Promise<BackgroundBashJob>;
}

export interface BackgroundBashPresentationHost {
  readonly renderCall?: NonNullable<ToolDefinition['renderCall']>;
  install?(pi: Pick<FelanExtensionAPI, 'registerMessageRenderer'>): void;
  status(ui: ExtensionContext['ui'], running: number | 'unavailable' | undefined): void;
  show(ui: ExtensionContext['ui'], source: BackgroundProcessViewSource, signal: AbortSignal): Promise<void>;
}
