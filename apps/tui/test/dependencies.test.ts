import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentRuntime,
  ExtensionContext,
  FelanExtensionAPI,
} from '@felan-ai/agent-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createLocalDependencyExtension,
  localRuntimeDependencies,
  type LocalRuntimeDependency,
} from '../src/dependencies.js';
import { createLocalSettingsManager } from '../src/settings.js';

type Handler = (event: any, ctx: ExtensionContext) => unknown;

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe('local runtime dependency onboarding', () => {
  it('registers only primary binary-backed or platform-gated extension behavior', () => {
    expect(localRuntimeDependencies.map(({ id }) => id)).toEqual([
      'background-bash',
      'markitdown',
      'rtk',
    ]);
    expect(localRuntimeDependencies.find(({ id }) => id === 'background-bash')?.install).toBeUndefined();
  });

  it('installs only after confirmation and remembers the RTK compaction-only choice', async () => {
    const fixture = await createFixture();
    const install = vi.fn(async () => ({ available: true as const, version: '1.2.3' }));
    const markitdown = dependency({ id: 'markitdown', extension: 'markitdown', install });
    const rtk = dependency({
      id: 'rtk',
      extension: 'rtkOptimizer',
      unavailableChoice: 'Continue with output compaction only',
      unavailableOutcome: 'continue',
    });
    const harness = await createHarness(fixture, [markitdown, rtk], {
      selections: ['Install markitdown', 'Continue with output compaction only'],
      confirmations: [true],
    });

    expect(harness.commands.has('dependencies')).toBe(true);
    await harness.emit('session_start', { reason: 'startup' });

    expect(harness.confirm).toHaveBeenCalledWith('Install markitdown', 'Install markitdown?');
    expect(install).toHaveBeenCalledOnce();
    expect(harness.notifications).toContainEqual(['markitdown installed (1.2.3).', 'info']);
    const settings = JSON.parse(await readFile(join(fixture.agentDir, 'settings.json'), 'utf8'));
    expect(settings.felanTui.dependencyOnboarding).toEqual({ rtk: 'continue' });
  });

  it('persists extension disablement and does not ask again on reload', async () => {
    const fixture = await createFixture();
    const markitdown = dependency({ id: 'markitdown', extension: 'markitdown' });
    const harness = await createHarness(fixture, [markitdown], {
      selections: ['Disable markitdown extension'],
    });

    await harness.emit('session_start', { reason: 'startup' });
    await harness.emit('session_start', { reason: 'reload' });

    expect(harness.select).toHaveBeenCalledTimes(1);
    const settings = JSON.parse(await readFile(join(fixture.agentDir, 'settings.json'), 'utf8'));
    expect(settings.builtinExtensions.markitdown).toBe(false);
  });

  it('never opens onboarding outside interactive startup', async () => {
    const fixture = await createFixture();
    const harness = await createHarness(fixture, [dependency({ id: 'rtk', extension: 'rtkOptimizer' })], {
      mode: 'print',
    });

    await harness.emit('session_start', { reason: 'startup' });

    expect(harness.select).not.toHaveBeenCalled();
  });
});

function dependency(options: {
  id: string;
  extension: 'markitdown' | 'rtkOptimizer';
  unavailableChoice?: string;
  unavailableOutcome?: 'disable-extension' | 'continue';
  install?: LocalRuntimeDependency['install'];
}): LocalRuntimeDependency {
  return {
    id: options.id,
    label: options.id,
    extension: options.extension,
    purpose: `${options.id} purpose`,
    installConfirmation: `Install ${options.id}?`,
    unavailableChoice: options.unavailableChoice ?? `Disable ${options.id} extension`,
    unavailableOutcome: options.unavailableOutcome ?? 'disable-extension',
    check: async () => ({ available: false, reason: 'not found' }),
    install: options.install ?? (async () => ({ available: false, reason: 'unused' })),
  };
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'felan-dependencies-'));
  temporaryPaths.push(root);
  const cwd = join(root, 'workspace');
  const agentDir = join(root, 'agent');
  await Promise.all([mkdir(cwd, { recursive: true }), mkdir(agentDir, { recursive: true })]);
  return {
    agentDir,
    runtime: { cwd, kind: 'host' } as AgentRuntime,
    settingsManager: createLocalSettingsManager(cwd, agentDir),
  };
}

async function createHarness(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  dependencies: readonly LocalRuntimeDependency[],
  uiOptions: {
    selections?: string[];
    confirmations?: boolean[];
    mode?: ExtensionContext['mode'];
  },
) {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
  const notifications: Array<[string, string | undefined]> = [];
  const selections = [...(uiOptions.selections ?? [])];
  const confirmations = [...(uiOptions.confirmations ?? [])];
  const select = vi.fn(async () => selections.shift());
  const confirm = vi.fn(async () => confirmations.shift() ?? false);
  const ctx = {
    cwd: fixture.runtime.cwd,
    hasUI: uiOptions.mode !== 'print',
    mode: uiOptions.mode ?? 'tui',
    ui: {
      select,
      confirm,
      notify: (message: string, level?: string) => notifications.push([message, level]),
      setStatus: vi.fn(),
    },
  } as unknown as ExtensionContext;
  const pi = {
    runtime: fixture.runtime,
    agentDir: fixture.agentDir,
    registerCapability: vi.fn(),
    registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => {
      commands.set(name, command);
    },
    on: (name: string, handler: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
  } as unknown as FelanExtensionAPI;
  await createLocalDependencyExtension({
    agentDir: fixture.agentDir,
    settingsManager: fixture.settingsManager,
    dependencies,
  })(pi);

  return {
    commands,
    confirm,
    notifications,
    select,
    async emit(name: string, event: Record<string, unknown>): Promise<void> {
      for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
    },
  };
}
