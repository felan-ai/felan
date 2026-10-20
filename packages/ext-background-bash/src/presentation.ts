import type { BackgroundBashJob, BackgroundBashStatusFilter } from './job-store.js';

export const BACKGROUND_BASH_COMPLETION_MESSAGE_TYPE = 'felan-background-bash-completion';

export interface BackgroundProcessViewSource {
  list(status: BackgroundBashStatusFilter): Promise<BackgroundBashJob[]>;
  tail(id: string, lines?: number): Promise<string>;
  stop(id: string, signal?: 'SIGTERM' | 'SIGKILL'): Promise<BackgroundBashJob>;
  write?(id: string, chars: string): Promise<void>;
}

