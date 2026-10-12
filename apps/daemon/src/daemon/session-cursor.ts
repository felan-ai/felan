import type { SessionManager } from '@felan-ai/agent-core';
import { IdSchema, parseSchema } from '@felan-ai/session-protocol';

export interface SessionBranchCursor {
  readonly branch: string;
  readonly observedTip?: string;
}

export function sessionTip(manager: SessionManager): string {
  return manager.getEntries().at(-1)?.id ?? manager.getSessionId();
}

export function restoreSessionCursor(manager: SessionManager, cursor: SessionBranchCursor): void {
  const session = manager.getSessionId();
  const selected = parseSchema(IdSchema, cursor.branch);
  const observed = cursor.observedTip === undefined ? undefined : parseSchema(IdSchema, cursor.observedTip);
  if (selected !== session && !manager.getEntry(selected)) throw new Error('The persisted active branch is missing from Pi.');
  let branch = selected;
  const tip = sessionTip(manager);
  if (observed !== undefined && tip !== observed) {
    const entries = manager.getEntries();
    const offset = observed === session ? -1 : entries.findIndex(entry => entry.id === observed);
    if (offset === -1 && observed !== session) throw new Error('The observed transcript tip is missing from Pi.');
    let parent: string | null = selected === session ? null : selected;
    for (const entry of entries.slice(offset + 1)) {
      if (entry.parentId !== parent) throw new Error('Unobserved transcript entries do not extend the selected branch.');
      parent = entry.id;
    }
    branch = tip;
  }
  if (branch === session) manager.resetLeaf();
  else manager.branch(branch);
}
