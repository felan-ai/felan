import type { SessionExecutionPort, SessionExtensionContext } from '@felan-ai/daemon/provider';
import type { SavingsService } from './savings.js';

export interface LocalExecutionRoot {
  savings: SavingsService;
  settle(mode?: 'drain' | 'force'): Promise<void>;
  close(): Promise<void>;
}

export interface LocalExecutionSession {
  readonly context: Omit<SessionExtensionContext, 'services'>;
  readonly port: SessionExecutionPort;
  readonly root: LocalExecutionRoot;
  readonly isRoot: boolean;
  attention(active: boolean, label?: string): void;
}

