import type { SessionManager } from '@felan-ai/agent-core';

export function sessionTip(manager: SessionManager): string {
  return manager.getEntries().at(-1)?.id ?? manager.getSessionId();
}
