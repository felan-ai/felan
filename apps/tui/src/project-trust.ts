import { dirname, join, resolve } from 'node:path';
import { ProjectTrustStore, type ProjectTrustDecision } from '@earendil-works/pi-coding-agent';

export type { ProjectTrustDecision, ProjectTrustStore } from '@earendil-works/pi-coding-agent';

export type ProjectTrustPromptChoice = 'trust' | 'trust-parent' | 'deny' | 'skip';

export function felanProjectTrustPath(agentDir: string): string {
  return join(agentDir, 'trust.json');
}

export function createFelanProjectTrustStore(agentDir: string): ProjectTrustStore {
  return new ProjectTrustStore(agentDir);
}

export function getFelanProjectTrustParentPath(cwd: string): string | undefined {
  const resolved = resolve(cwd);
  const parent = dirname(resolved);
  return parent === resolved ? undefined : parent;
}

export function applyProjectTrustChoice(
  store: ProjectTrustStore,
  cwd: string,
  choice: ProjectTrustPromptChoice,
): ProjectTrustDecision {
  if (choice === 'skip') return null;
  if (choice === 'trust') {
    store.set(cwd, true);
    return true;
  }
  if (choice === 'deny') {
    store.set(cwd, false);
    return false;
  }
  const parent = getFelanProjectTrustParentPath(cwd);
  if (parent === undefined) {
    store.set(cwd, true);
    return true;
  }
  store.setMany([
    { path: parent, decision: true },
    { path: cwd, decision: null },
  ]);
  return true;
}
