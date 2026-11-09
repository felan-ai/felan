import { createHash } from 'node:crypto';
import {
  ExtensionUiUnavailableError, SESSIONS_HISTORY_SERVICE, SessionsServiceError, createFelanServiceRegistry,
  type ExtensionContext, type FelanExtensionAPI, type SessionsHistory, type UiActionRequest, type UiDocument, type UiPresentOptions,
} from '@felan-ai/agent-core';
import { describe, expect, it, vi } from 'vitest';
import { SavingsService } from '../src/providers/savings.js';
import { createSavingsCommandExtension, createSavingsExtension, parseSavingsArgs } from '../src/savings-command.js';
import { SAVINGS_DASHBOARD_HINT, readSavingsDashboard } from '../src/savings/data.js';
import { TestAgentRuntime } from '../../../packages/agent-core/test/test-agent-runtime.js';

const ROOT = '01a1bfb3-4375-7364-b6ac-b4a5cc04e760';
const PROJECT = createHash('sha256').update('/work/felan').digest('hex');

async function savingsService(): Promise<SavingsService> {
  const service = new SavingsService({ runtime: new TestAgentRuntime('/workspace'), rootSessionId: ROOT, projectKey: PROJECT });
  await service.createReporter('@felan-ai/ext-rtk-optimizer').report({
    category: 'output-optimization', operation: 'post-tool-compaction',
    baseline: { costUsd: 3, tokens: { input: 100, output: 0 } }, actual: { costUsd: 1, tokens: { input: 40, output: 0 } },
    basis: { kind: 'estimated-baseline', method: 'utf8-bytes/4-ceil-v1' },
  });
  return service;
}

function harness(service: SavingsService, options: { sessions?: SessionsHistory; unavailable?: boolean } = {}) {
  const commands = new Map<string, { handler: (args: string, context: ExtensionContext) => Promise<void>; getArgumentCompletions: (prefix: string) => unknown }>();
  const presented: Array<{ document: UiDocument; options: UiPresentOptions; handle: { update: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } }> = [];
  const pi = {
    on: vi.fn(),
    runtime: { cwd: '/work/felan' },
    registerCommand: (name: string, command: never) => { commands.set(name, command); },
    services: { get: (contract: unknown) => contract === SESSIONS_HISTORY_SERVICE ? options.sessions : undefined },
    ui: {
      present: async (document: UiDocument, presentOptions: UiPresentOptions) => {
        if (options.unavailable) throw new ExtensionUiUnavailableError();
        const handle = { update: vi.fn(async () => {}), close: vi.fn(async () => {}) };
        presented.push({ document, options: presentOptions, handle });
        return handle;
      },
    },
  } as unknown as FelanExtensionAPI;
  createSavingsExtension(service)(pi);
  const notify = vi.fn();
  const command = commands.get('savings')!;
  const run = (args = '') => command.handler(args, { ui: { notify } } as unknown as ExtensionContext);
  const act = (index: number, request: Partial<UiActionRequest>) => presented[index]!.options.onAction!(
    { elementId: 'savings-dashboard', revision: presented[index]!.document.revision, actionId: 'refresh', outcome: 'submit', values: {}, ...request },
    { requestId: 'request', signal: new AbortController().signal });
  return { run, act, notify, presented, command };
}

function history(pages: SessionsHistory['list'][]): SessionsHistory {
  const list = vi.fn<SessionsHistory['list']>();
  for (const page of pages) list.mockImplementationOnce(page);
  return { list } as unknown as SessionsHistory;
}

describe('savings command', () => {
  it('parses ranges and tab aliases', () => {
    expect(parseSavingsArgs('')).toEqual({});
    expect(parseSavingsArgs(' 7d ')).toEqual({ range: '7d' });
    expect(parseSavingsArgs('ALL project')).toEqual({ range: 'all', tab: 'projects' });
    expect(parseSavingsArgs('details 90d')).toEqual({ range: '90d', tab: 'extensions' });
    expect(parseSavingsArgs('7d 30d')).toBeUndefined();
    expect(parseSavingsArgs('project details')).toBeUndefined();
    expect(parseSavingsArgs('weekly')).toBeUndefined();
  });

  it('binds a hidden host-owned extension that registers only savings', async () => {
    const registerCommand = vi.fn();
    const extension = createSavingsCommandExtension(await savingsService(), {
      runtime: new TestAgentRuntime('/workspace'), resources: { agentDir: '/agent' } as never, services: createFelanServiceRegistry(),
    });
    expect(extension).toMatchObject({ name: '@felan-ai/felan/savings', hidden: true });
    if (typeof extension === 'function') throw new Error('Expected a named inline extension');
    await extension.factory({ registerCommand, on: vi.fn() } as never);
    expect(registerCommand).toHaveBeenCalledTimes(1);
    expect(registerCommand).toHaveBeenCalledWith('savings', expect.any(Object));
  });

  it('presents a hinted dashboard with session labels, range and tab from the arguments', async () => {
    const sessions = history([
      async () => { throw new SessionsServiceError('stale'); },
      async () => ({ items: [{ id: ROOT, root: ROOT, title: 'Savings work', cwd: '/work/felan', updatedAt: 1, state: 'open' }], nextCursor: 'next' }),
      async () => ({ items: [] }),
    ]);
    const h = harness(await savingsService(), { sessions });
    await h.run('7d project');
    expect(h.presented).toHaveLength(1);
    const { document } = h.presented[0]!;
    expect(document).toMatchObject({ id: 'savings-dashboard', kind: 'document', revision: 1, title: 'Estimated savings', hint: SAVINGS_DASHBOARD_HINT,
      fallback: 'Estimated savings: $2.00 saved, last 7 days' });
    expect(document.actions.map(action => [action.id, action.outcome])).toEqual([['refresh', 'submit'], ['close', 'cancel']]);
    expect(document.markdown).toContain('# Estimated savings — Last 7 days');
    const dashboard = readSavingsDashboard(document.data);
    expect(dashboard).toMatchObject({ initialRange: '7d', initialTab: 'projects' });
    expect(dashboard.sessions[dashboard.currentSession!]!.title).toBe('Savings work');
    expect(dashboard.projects[dashboard.currentProject!]!.label).toBe('felan');
    expect(dashboard.ranges.find(range => range.id === 'all')!.totals).toMatchObject({ savedUsd: 2, decisions: 1, savedTokens: 60 });
    expect(sessions.list).toHaveBeenCalledTimes(3);
  });

  it('falls back to short session labels when history is unavailable', async () => {
    const h = harness(await savingsService(), { sessions: history([async () => { throw new SessionsServiceError('inaccessible'); }]) });
    await h.run();
    const dashboard = readSavingsDashboard(h.presented[0]!.document.data);
    expect(dashboard.sessions[dashboard.currentSession!]!.title).toBe('Session 01a1bfb3');
    expect(dashboard.projects[dashboard.currentProject!]!.label).toBe('felan');
    expect(dashboard.initialRange).toBe('30d');
  });

  it('refreshes in place and rejects stale, undeclared or valued actions', async () => {
    const service = await savingsService();
    const h = harness(service);
    await h.run();
    await service.createReporter('@felan-ai/ext-output-style').report({
      category: 'output-optimization', operation: 'concise-response', baseline: { costUsd: 1.5 }, actual: { costUsd: 1 },
      basis: { kind: 'estimated-baseline', method: 'concise-output-token-ratio-202609-v1' },
    });
    await h.act(0, {});
    const { handle } = h.presented[0]!;
    expect(handle.update).toHaveBeenCalledOnce();
    const next = handle.update.mock.calls[0]![0] as UiDocument;
    expect(next).toMatchObject({ id: 'savings-dashboard', revision: 2 });
    expect(readSavingsDashboard(next.data).ranges.find(range => range.id === 'all')!.totals.savedUsd).toBe(2.5);
    await expect(h.act(0, { revision: 1 })).rejects.toThrow('Savings action is unavailable.');
    await expect(h.act(0, { revision: 2, actionId: 'open-browser' })).rejects.toThrow('Savings action is unavailable.');
    await expect(h.act(0, { revision: 2, values: { range: '7d' } })).rejects.toThrow('Savings action is unavailable.');
  });

  it('closes on the close action and replaces an open dashboard on the next command', async () => {
    const h = harness(await savingsService());
    await h.run();
    await h.act(0, { actionId: 'close', outcome: 'cancel' });
    expect(h.presented[0]!.handle.close).toHaveBeenCalledOnce();
    await expect(h.act(0, {})).rejects.toThrow('Savings action is unavailable.');
    await h.run('all');
    await h.run('today');
    expect(h.presented).toHaveLength(3);
    expect(h.presented[1]!.handle.close).toHaveBeenCalledOnce();
    expect(h.presented[2]!.document.revision).toBeGreaterThan(h.presented[1]!.document.revision);
    expect(readSavingsDashboard(h.presented[2]!.document.data).initialRange).toBe('today');
  });

  it('prints a text report when generic UI is unavailable and reports invalid arguments', async () => {
    const h = harness(await savingsService(), { unavailable: true });
    await h.run('weekly');
    expect(h.notify).toHaveBeenLastCalledWith('Usage: /savings [today|7d|30d|90d|all] [project|details]', 'warning');
    await h.run();
    expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining('Felan Code estimated savings — all'), 'info');
    expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining('@felan-ai/ext-rtk-optimizer'), 'info');
    expect(h.presented).toHaveLength(0);
  });

  it('completes ranges and tab aliases', async () => {
    const h = harness(await savingsService());
    expect(h.command.getArgumentCompletions('p')).toEqual([{ value: 'project', label: 'project' }]);
    expect(h.command.getArgumentCompletions('9')).toEqual([{ value: '90d', label: '90d' }]);
    expect(h.command.getArgumentCompletions('7d ')).toEqual([{ value: '7d project', label: 'project' }, { value: '7d details', label: 'details' }]);
    expect(h.command.getArgumentCompletions('details a')).toEqual([{ value: 'details all', label: 'all' }]);
    expect(h.command.getArgumentCompletions('7d project ')).toBeNull();
    expect(h.command.getArgumentCompletions('weekly ')).toBeNull();
  });
});
