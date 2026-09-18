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
      checkedIndexes: [0],
    });

    expect(harness.commands.has('dependencies')).toBe(true);
    await harness.emit('session_start', { reason: 'startup' });

    expect(harness.confirm).not.toHaveBeenCalled();
    expect(install).toHaveBeenCalledOnce();
    expect(harness.setStatus).not.toHaveBeenCalled();
    expect(harness.setWidget).not.toHaveBeenCalled();
    expect(harness.notifications).toContainEqual(['markitdown installed (1.2.3). Restart Felan Code to load the extension.', 'info']);
    const settings = JSON.parse(await readFile(join(fixture.agentDir, 'settings.json'), 'utf8'));
    expect(settings.felanTui.onboarding).toEqual({
      schemaVersion: 1,
      extensions: { markitdown: 1, rtkOptimizer: 1 },
    });
  });

  it('installs the browser CLI only after confirmation', async () => {
    const fixture = await createFixture();
    const install = vi.fn(async () => ({ available: true as const, version: '0.37.1' }));
    const browser = dependency({
      id: 'agent-browser',
      extension: 'browser',
      install,
      unavailableChoice: 'Disable the Browser extension',
    });
    const harness = await createHarness(fixture, [browser], {
      checkedIndexes: [0],
    });

    await harness.emit('session_start', { reason: 'startup' });

    expect(harness.confirm).not.toHaveBeenCalled();
    expect(install).toHaveBeenCalledOnce();
    expect(harness.notifications).toContainEqual(['agent-browser installed (0.37.1). Restart Felan Code to load the extension.', 'info']);
  });

  it('shows one unchecked checklist and installs only checked dependencies', async () => {
    const fixture = await createFixture();
    const installs = new Map<string, ReturnType<typeof vi.fn>>();
    const dependencies = ['agent-browser', 'codebase-memory', 'markitdown', 'rtk'].map((id) => {
      const install = vi.fn(async () => ({ available: true as const, version: '1.0.0' }));
      installs.set(id, install);
      return dependency({
        id,
        extension: id === 'agent-browser' ? 'browser' : id === 'codebase-memory' ? 'codebaseMemory' : id === 'markitdown' ? 'markitdown' : 'rtkOptimizer',
        install,
      });
    });
    const harness = await createHarness(fixture, dependencies, { checkedIndexes: [0, 2] });

    await harness.emit('session_start', { reason: 'startup' });

    expect(harness.custom).toHaveBeenCalledOnce();
    expect(harness.confirm).not.toHaveBeenCalled();
    expect(installs.get('agent-browser')).toHaveBeenCalledOnce();
    expect(installs.get('codebase-memory')).not.toHaveBeenCalled();
    expect(installs.get('markitdown')).toHaveBeenCalledOnce();
    expect(installs.get('rtk')).not.toHaveBeenCalled();
    const settings = JSON.parse(await readFile(join(fixture.agentDir, 'settings.json'), 'utf8'));
    expect(settings.felanTui.onboarding.extensions).toEqual({
      browser: 1,
      codebaseMemory: 1,
      markitdown: 1,
      rtkOptimizer: 1,
    });
  });

  it('leaves all onboarding records pending when the checklist is cancelled', async () => {
    const fixture = await createFixture();
    const install = vi.fn(async () => ({ available: true as const }));
    const harness = await createHarness(fixture, [dependency({ id: 'agent-browser', extension: 'browser', install })], {
      cancelCustom: true,
    });

    await harness.emit('session_start', { reason: 'startup' });

    expect(install).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(join(fixture.agentDir, 'settings.json'), 'utf8'))).toEqual({});
  });

  it('keeps the onboarding UI open until selected installations finish', async () => {
    const fixture = await createFixture();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const install = vi.fn(async () => {
      await gate;
      return { available: true as const, version: '1.0.0' };
    });
    const harness = await createHarness(fixture, [
      dependency({ id: 'markitdown', extension: 'markitdown', install }),
    ], { checkedIndexes: [0] });

    const started = harness.emit('session_start', { reason: 'startup' });
    await vi.waitFor(() => expect(install).toHaveBeenCalledOnce());
    expect(JSON.parse(await readFile(join(fixture.agentDir, 'settings.json'), 'utf8'))).toEqual({});
    expect(harness.setStatus).not.toHaveBeenCalled();
    expect(harness.setWidget).not.toHaveBeenCalled();

    release?.();
    await started;
    const settings = JSON.parse(await readFile(join(fixture.agentDir, 'settings.json'), 'utf8'));
    expect(settings.felanTui.onboarding.extensions.markitdown).toBe(1);
  });

  it('continues selected installations after a failure', async () => {
    const fixture = await createFixture();
    const failed = vi.fn(async () => ({ available: false as const, reason: 'download failed' }));
    const succeeded = vi.fn(async () => ({ available: true as const, version: '1.0.0' }));
    const first = dependency({ id: 'agent-browser', extension: 'browser', install: failed });
    const second = dependency({ id: 'markitdown', extension: 'markitdown', install: succeeded });
    const harness = await createHarness(fixture, [first, second], { checkedIndexes: [0, 1] });

    await harness.emit('session_start', { reason: 'startup' });

    expect(failed).toHaveBeenCalledOnce();
    expect(succeeded).toHaveBeenCalledOnce();
    const settings = JSON.parse(await readFile(join(fixture.agentDir, 'settings.json'), 'utf8'));
    expect(settings.felanTui.onboarding.extensions).toEqual({ markitdown: 1 });
    expect(settings.builtinExtensions.browser).toBeUndefined();
  });

  it('persists browser extension disablement', async () => {
    const fixture = await createFixture();
    const browser = dependency({
      id: 'agent-browser',
      extension: 'browser',
      unavailableChoice: 'Disable the Browser extension',
    });
    const harness = await createHarness(fixture, [browser], {
      checkedIndexes: [],
    });

    await harness.emit('session_start', { reason: 'startup' });

    expect(harness.custom).toHaveBeenCalledOnce();
    const settings = JSON.parse(await readFile(join(fixture.agentDir, 'settings.json'), 'utf8'));
    expect(settings.builtinExtensions.browser).toBe(false);
    expect(settings.felanTui.onboarding).toEqual({ schemaVersion: 1, extensions: { browser: 1 } });
  });

  it('persists extension disablement and does not ask again on reload', async () => {
    const fixture = await createFixture();
    const markitdown = dependency({ id: 'markitdown', extension: 'markitdown' });
    const harness = await createHarness(fixture, [markitdown], {
      checkedIndexes: [],
    });

    await harness.emit('session_start', { reason: 'startup' });
    await harness.emit('session_start', { reason: 'reload' });

    expect(harness.custom).toHaveBeenCalledOnce();
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
    const harness = await createHarness(fixture, [browser], {});

    await harness.emit('session_start', { reason: 'startup' });

    expect(harness.custom).not.toHaveBeenCalled();
    const settings = JSON.parse(await readFile(join(fixture.agentDir, 'settings.json'), 'utf8'));
    expect(settings.builtinExtensions.browser).toBe(true);
    expect(settings.felanTui.onboarding).toEqual({ schemaVersion: 1, extensions: { browser: 1 } });
  });

  it('does not probe a complete manifest and reopens only a changed revision', async () => {
    const fixture = await createFixture();
    const check = vi.fn(() => new Promise<RuntimeDependencyStatus>(() => {}));
    const browser = dependency({ id: 'agent-browser', extension: 'browser', check });
    await setOnboarding(fixture.agentDir, 'browser', 1);
    const harness = await createHarness(fixture, [browser], { checkedIndexes: [] });

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
    expect(changedHarness.custom).toHaveBeenCalledOnce();
  });

  it('leaves onboarding pending when installation fails or the user defers', async () => {
    const fixture = await createFixture();
    const failing = dependency({
      id: 'agent-browser',
      extension: 'browser',
      install: async () => ({ available: false, reason: 'download failed' }),
    });
    const harness = await createHarness(fixture, [failing], {
      checkedIndexes: [0],
    });
    await harness.emit('session_start', { reason: 'startup' });
    expect(harness.custom).toHaveBeenCalledOnce();
    const afterFailure = JSON.parse(await readFile(join(fixture.agentDir, 'settings.json'), 'utf8'));
    expect(afterFailure.felanTui?.onboarding).toBeUndefined();

    const deferred = await createHarness(fixture, [failing], { cancelCustom: true });
    await deferred.emit('session_start', { reason: 'startup' });
    expect(deferred.custom).toHaveBeenCalledOnce();
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
    checkedIndexes?: number[];
    cancelCustom?: boolean;
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
  const setStatus = vi.fn();
  const setWidget = vi.fn();
  const custom = vi.fn(async (factory: (...args: any[]) => any) => {
    let component: { handleInput?: (data: string) => void; dispose?: () => void } | undefined;
    return await new Promise((resolve) => {
      let settled = false;
      const done = (value: unknown) => {
        if (settled) return;
        settled = true;
        try { component?.dispose?.(); } catch { /* ignore */ }
        resolve(value);
      };
      component = factory(
        { requestRender: vi.fn(), terminal: { rows: 24 } },
        { fg: (_color: string, text: string) => text, bold: (text: string) => text },
        { matches: () => false },
        done,
      );
      if (uiOptions.cancelCustom) {
        component?.handleInput?.('\u001b');
        return;
      }
      if (typeof component?.handleInput !== 'function') return;
      for (const index of uiOptions.checkedIndexes ?? []) {
        for (let step = 0; step < index; step += 1) component.handleInput?.('\u001b[B');
        component.handleInput?.(' ');
        for (let step = index; step > 0; step -= 1) component.handleInput?.('\u001b[A');
      }
      component.handleInput?.('\r');
    });
  });
  const ctx = {
    cwd: fixture.runtime.cwd,
    hasUI: uiOptions.mode !== 'print',
    mode: uiOptions.mode ?? 'tui',
    ui: {
      select,
      confirm,
      custom,
      notify: (message: string, level?: string) => notifications.push([message, level]),
      setStatus,
      setWidget,
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
    custom,
    notifications,
    select,
    setStatus,
    setWidget,
    async emit(name: string, event: Record<string, unknown>): Promise<void> {
      for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
    },
    async runCommand(name: string, args: string): Promise<void> {
      await commands.get(name)!.handler(args, ctx);
    },
  };
}
