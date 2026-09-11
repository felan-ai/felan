import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  type RuntimeDependencyStatus,
  type LocalRuntimeDependency,
} from '../src/dependencies.js';
import { createLocalSettingsManager, setBuiltinExtensionEnabled } from '../src/settings.js';

type Handler = (event: any, ctx: ExtensionContext) => unknown;

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe('local runtime dependency onboarding', () => {
  it('registers only primary binary-backed or platform-gated extension behavior', () => {
    expect(localRuntimeDependencies.map(({ id }) => id)).toEqual([
      'background-bash',
      'agent-browser',
      'codebase-memory',
      'markitdown',
      'rtk',
    ]);
    const processes = localRuntimeDependencies.find(({ id }) => id === 'background-bash');
    expect(processes?.install).toBeUndefined();
    expect(processes).toMatchObject({
      label: 'Background processes',
      extension: 'backgroundBash',
      unavailableChoice: 'Disable background processes',
    });
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
    expect(harness.notifications).toContainEqual(['markitdown installed (1.2.3). Restart Felan Code to load the extension.', 'info']);
    const settings = JSON.parse(await readFile(join(fixture.agentDir, 'settings.json'), 'utf8'));
    expect(settings.felanTui.onboarding).toEqual({
      schemaVersion: 1,
      extensions: { markitdown: 1, rtkOptimizer: 1 },
    });
  });

  it('installs the browser CLI only after confirmation', async () => {
    const fixture = await createFixture();
    const install = vi.fn(async () => ({ available: true as const, version: '0.31.1' }));
    const browser = dependency({
      id: 'agent-browser',
      extension: 'browser',
      install,
      unavailableChoice: 'Disable the Browser extension',
    });
    const harness = await createHarness(fixture, [browser], {
      selections: ['Install agent-browser'],
      confirmations: [true],
    });

    await harness.emit('session_start', { reason: 'startup' });

    expect(harness.confirm).toHaveBeenCalledWith('Install agent-browser', 'Install agent-browser?');
    expect(install).toHaveBeenCalledOnce();
    expect(harness.notifications).toContainEqual(['agent-browser installed (0.31.1). Restart Felan Code to load the extension.', 'info']);
  });

  it('persists browser extension disablement', async () => {
    const fixture = await createFixture();
    const browser = dependency({
      id: 'agent-browser',
      extension: 'browser',
      unavailableChoice: 'Disable the Browser extension',
    });
    const harness = await createHarness(fixture, [browser], {
      selections: ['Disable the Browser extension'],
    });

    await harness.emit('session_start', { reason: 'startup' });

    expect(harness.select).toHaveBeenCalledOnce();
    const settings = JSON.parse(await readFile(join(fixture.agentDir, 'settings.json'), 'utf8'));
    expect(settings.builtinExtensions.browser).toBe(false);
    expect(settings.felanTui.onboarding).toEqual({ schemaVersion: 1, extensions: { browser: 1 } });
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
    expect(settings.felanTui.onboarding).toEqual({ schemaVersion: 1, extensions: { markitdown: 1 } });
  });

  it('never opens onboarding outside interactive startup', async () => {
    const fixture = await createFixture();
    const harness = await createHarness(fixture, [dependency({ id: 'rtk', extension: 'rtkOptimizer' })], {
      mode: 'print',
    });

    await harness.emit('session_start', { reason: 'startup' });

    expect(harness.select).not.toHaveBeenCalled();
  });

  it('records an explicit decision for an already available dependency', async () => {
    const fixture = await createFixture();
    const browser = dependency({
      id: 'agent-browser',
      extension: 'browser',
      available: true,
      unavailableChoice: 'Disable the Browser extension',
    });
    const harness = await createHarness(fixture, [browser], { selections: ['Enable agent-browser'] });

    await harness.emit('session_start', { reason: 'startup' });

    expect(harness.select).toHaveBeenCalledOnce();
    const settings = JSON.parse(await readFile(join(fixture.agentDir, 'settings.json'), 'utf8'));
    expect(settings.builtinExtensions.browser).toBe(true);
    expect(settings.felanTui.onboarding).toEqual({ schemaVersion: 1, extensions: { browser: 1 } });
  });

  it('does not probe a complete manifest and reopens only a changed revision', async () => {
    const fixture = await createFixture();
    const check = vi.fn(() => new Promise<RuntimeDependencyStatus>(() => {}));
    const browser = dependency({ id: 'agent-browser', extension: 'browser', check });
    await setOnboarding(fixture.agentDir, 'browser', 1);
    const harness = await createHarness(fixture, [browser], { selections: ['Disable agent-browser extension'] });

    await expect(Promise.race([
      harness.emit('session_start', { reason: 'startup' }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('startup blocked')), 50)),
    ])).resolves.toBeUndefined();
    expect(check).not.toHaveBeenCalled();
    expect(harness.select).not.toHaveBeenCalled();

    const changedCheck = vi.fn(async () => ({ available: false, reason: 'slow probe' }));
    const changed = dependency({ id: 'agent-browser', extension: 'browser', check: changedCheck, revision: 2 });
    const changedHarness = await createHarness(fixture, [changed], { selections: ['Disable agent-browser extension'] });
    await changedHarness.emit('session_start', { reason: 'startup' });
    expect(changedCheck).toHaveBeenCalledOnce();
    expect(changedHarness.select).toHaveBeenCalledOnce();
  });

  it('leaves onboarding pending when installation fails or the user defers', async () => {
    const fixture = await createFixture();
    const failing = dependency({
      id: 'agent-browser',
      extension: 'browser',
      install: async () => ({ available: false, reason: 'download failed' }),
    });
    const harness = await createHarness(fixture, [failing], {
      selections: ['Install agent-browser'],
      confirmations: [true],
    });
    await harness.emit('session_start', { reason: 'startup' });
    expect(harness.select).toHaveBeenCalledOnce();
    const afterFailure = JSON.parse(await readFile(join(fixture.agentDir, 'settings.json'), 'utf8'));
    expect(afterFailure.felanTui?.onboarding).toBeUndefined();

    const deferred = await createHarness(fixture, [failing], { selections: ['Decide later'] });
    await deferred.emit('session_start', { reason: 'startup' });
    expect(deferred.select).toHaveBeenCalledOnce();
    const afterDeferral = JSON.parse(await readFile(join(fixture.agentDir, 'settings.json'), 'utf8'));
    expect(afterDeferral.felanTui?.onboarding).toBeUndefined();
  });

  it('rechecks disabled dependencies and explicitly enables or disables available ones', async () => {
    const fixture = await createFixture();
    await setBuiltinExtensionEnabled(fixture.agentDir, 'browser', false);
    const check = vi.fn(async (): Promise<RuntimeDependencyStatus> => ({ available: true, version: '1.0.0' }));
    const browser = dependency({ id: 'agent-browser', extension: 'browser', available: true, check });
    const enable = await createHarness(fixture, [browser], {
      selections: ['agent-browser — disabled', 'Enable agent-browser without installing'],
    });
    await enable.runCommand('dependencies', '');
    expect(check).toHaveBeenCalledOnce();
    let settings = JSON.parse(await readFile(join(fixture.agentDir, 'settings.json'), 'utf8'));
    expect(settings.builtinExtensions.browser).toBe(true);
    expect(settings.felanTui.onboarding.extensions.browser).toBe(1);

    const disable = await createHarness(fixture, [browser], {
      selections: ['agent-browser — available (1.0.0)', 'Disable agent-browser'],
    });
    await disable.runCommand('dependencies', '');
    settings = JSON.parse(await readFile(join(fixture.agentDir, 'settings.json'), 'utf8'));
    expect(settings.builtinExtensions.browser).toBe(false);
  });
});

function dependency(options: {
  id: string;
  extension: 'backgroundBash' | 'browser' | 'codebaseMemory' | 'markitdown' | 'rtkOptimizer';
  revision?: number;
  available?: boolean;
  check?: LocalRuntimeDependency['check'];
  unavailableChoice?: string;
  unavailableOutcome?: 'disable-extension' | 'continue';
  install?: LocalRuntimeDependency['install'];
}): LocalRuntimeDependency {
  return {
    id: options.id,
    revision: options.revision ?? 1,
    label: options.id,
    extension: options.extension,
    purpose: `${options.id} purpose`,
    installConfirmation: `Install ${options.id}?`,
    unavailableChoice: options.unavailableChoice ?? `Disable ${options.id} extension`,
    unavailableOutcome: options.unavailableOutcome ?? 'disable-extension',
    check: options.check ?? (async () => options.available
      ? { available: true, version: '1.0.0' }
      : { available: false, reason: 'not found' }),
    install: options.install ?? (async () => ({ available: false, reason: 'unused' })),
  };
}

async function setOnboarding(agentDir: string, extension: string, revision: number): Promise<void> {
  const { setDependencyOnboardingDecision } = await import('../src/settings.js');
  await setDependencyOnboardingDecision(agentDir, {
    extension: extension as 'browser',
    revision,
    enabled: true,
  });
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'felan-dependencies-'));
  temporaryPaths.push(root);
  const cwd = join(root, 'workspace');
  const agentDir = join(root, 'agent');
  await Promise.all([mkdir(cwd, { recursive: true }), mkdir(agentDir, { recursive: true })]);
  await writeFile(join(agentDir, 'settings.json'), '{}\n');
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
    async runCommand(name: string, args: string): Promise<void> {
      await commands.get(name)!.handler(args, ctx);
    },
  };
}
