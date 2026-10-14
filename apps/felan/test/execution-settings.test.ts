import { expect, it, vi } from 'vitest';
import type { SessionExecutionPort, SessionExtensionContext } from '@felan-ai/daemon/provider';
import { createLocalExecutionServices } from '../src/providers/execution-services.js';

it('configures daemon concurrency and depth from local session settings after activation', async () => {
  const configureExecutions = vi.fn();
  const settings = { concurrency: 2, maxDepth: 5 };
  const context = { runtime: {}, rootSessionId: 'root', resources: { cwd: '/workspace', agentDir: '/agent' },
    settingsManager: { getSettings: () => ({ felanSubagents: settings }) }, services: { get: () => ({}) },
  } as unknown as SessionExtensionContext;
  const port = { current: { id: 'root', root: 'root' }, configureExecutions,
    registerService: () => () => {}, attachExecutionParent: () => () => {},
  } as unknown as SessionExecutionPort;
  const root = { savings: { hasPendingWork: () => false }, settle: async () => {}, close: async () => {} };
  const bindings = await createLocalExecutionServices({ open: async () => root, dispose: async () => {} })(context, port);
  expect(configureExecutions).not.toHaveBeenCalled();
  await bindings.onSession!({ resourceLoader: { getSkills: () => ({ skills: [] }) }, sessionManager: { getEntries: () => [] }, subscribe: () => () => {}, clearQueue() {}, dispose() {} } as never);
  expect(configureExecutions).toHaveBeenCalledWith(settings);
  await bindings.disposeUi?.();
});
