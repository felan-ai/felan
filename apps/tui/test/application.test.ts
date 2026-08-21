import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const interactive = vi.hoisted(() => ({
  agentDirs: [] as Array<string | undefined>,
  constructorError: undefined as Error | undefined,
  deferUpdateCheck: false,
  disposals: 0,
  events: [] as string[],
  piTelemetry: [] as Array<string | undefined>,
  piVersionChecks: [] as Array<string | undefined>,
  headerAdapters: [] as boolean[],
  initializations: 0,
  latestUpdate: undefined as string | undefined,
  modeOptions: [] as unknown[],
  runError: undefined as Error | undefined,
  runs: 0,
  toolRenderShells: [] as Array<string | undefined>,
  toolNames: [] as string[],
  updateCheckSignals: [] as AbortSignal[],
  warnings: [] as string[],
}));

vi.mock('@earendil-works/pi-coding-agent', async (importOriginal) => {
  const original = await importOriginal<typeof import('@earendil-works/pi-coding-agent')>();
  return {
    ...original,
    InteractiveMode: class {
      builtInHeader: unknown = undefined;

      constructor(
        private runtime: InstanceType<typeof original.AgentSessionRuntime>,
        options?: unknown,
      ) {
        interactive.agentDirs.push(process.env.PI_CODING_AGENT_DIR);
        interactive.piTelemetry.push(process.env.PI_TELEMETRY);
        interactive.piVersionChecks.push(process.env.PI_SKIP_VERSION_CHECK);
        interactive.modeOptions.push(options);
        const dispose = runtime.dispose.bind(runtime);
        runtime.dispose = async () => {
          interactive.disposals += 1;
          await dispose();
        };
        if (interactive.constructorError) throw interactive.constructorError;
      }

      async init() {
        interactive.initializations += 1;
        interactive.events.push('init');
      }

      async run() {
        interactive.runs += 1;
        interactive.events.push('run');
        interactive.headerAdapters.push(
          typeof Object.getOwnPropertyDescriptor(this, 'builtInHeader')?.get === 'function',
        );
        interactive.toolRenderShells.push(this.runtime.session.getToolDefinition('read')?.renderShell);
        interactive.toolNames = this.runtime.session.agent.state.tools.map((tool) => tool.name);
        if (interactive.runError) throw interactive.runError;
      }

      showWarning(message: string) {
        interactive.warnings.push(message);
        interactive.events.push('warning');
      }
    },
  };
});

vi.mock('../src/update.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/update.js')>();
  return {
    ...original,
    checkForFelanUpdate: async (options?: { signal?: AbortSignal }) => {
      interactive.events.push('check');
      if (options?.signal) interactive.updateCheckSignals.push(options.signal);
      if (interactive.deferUpdateCheck) {
        return new Promise<string | undefined>((resolve) => {
          const signal = options?.signal;
          if (!signal) {
            resolve(undefined);
            return;
          }
          const handleAbort = () => {
            interactive.events.push('check-abort');
            resolve(undefined);
          };
          if (signal.aborted) handleAbort();
          else signal.addEventListener('abort', handleAbort, { once: true });
        });
      }
      return interactive.latestUpdate;
    },
  };
});

import { runLocalFelan } from '../src/application.js';

const temporaryPaths: string[] = [];

afterEach(async () => {
  interactive.agentDirs = [];
  interactive.constructorError = undefined;
  interactive.deferUpdateCheck = false;
  interactive.disposals = 0;
  interactive.events = [];
  interactive.piTelemetry = [];
  interactive.piVersionChecks = [];
  interactive.headerAdapters = [];
  interactive.initializations = 0;
  interactive.latestUpdate = undefined;
  interactive.modeOptions = [];
  interactive.runError = undefined;
  interactive.runs = 0;
  interactive.toolRenderShells = [];
  interactive.toolNames = [];
  interactive.updateCheckSignals = [];
  interactive.warnings = [];
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe('interactive application', () => {
  it('runs Pi InteractiveMode with the composed local Agent Core runtime', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent');
    const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousPiSkipVersionCheck = process.env.PI_SKIP_VERSION_CHECK;
    const previousPiTelemetry = process.env.PI_TELEMETRY;
    await mkdir(cwd, { recursive: true });

    await runLocalFelan({ cwd, agentDir });

    expect(interactive.runs).toBe(1);
    expect(interactive.initializations).toBe(1);
    expect(interactive.agentDirs).toEqual([agentDir]);
    expect(interactive.piVersionChecks).toEqual(['1']);
    expect(interactive.piTelemetry).toEqual(['0']);
    expect(interactive.headerAdapters).toEqual([true]);
    expect(interactive.disposals).toBe(1);
    expect(interactive.toolRenderShells).toEqual(['self']);
    expect(process.env.PI_CODING_AGENT_DIR).toBe(previousPiAgentDir);
    expect(process.env.PI_SKIP_VERSION_CHECK).toBe(previousPiSkipVersionCheck);
    expect(process.env.PI_TELEMETRY).toBe(previousPiTelemetry);
    expect(interactive.toolNames).toEqual(expect.arrayContaining([
      'read',
      'bash',
      'Agent',
      'list_subagents',
      'get_subagent_result',
      'steer_subagent',
      'cancel_subagent',
      'TaskCreate',
      'TaskUpdate',
      'TaskList',
      'TaskGet',
    ]));
    expect(interactive.toolNames).not.toContain('spawn_agent');
  });

  it('checks for a Felan update after initialization and reports a newer release', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent');
    await mkdir(cwd, { recursive: true });
    interactive.latestUpdate = '0.13.2';

    await runLocalFelan({ cwd, agentDir });

    expect(interactive.events).toEqual(['init', 'check', 'run', 'warning']);
    expect(interactive.warnings).toEqual([
      'Felan 0.13.2 is available. Exit all Felan sessions, then run felan update '
        + '(global npm) or update with your package manager.',
    ]);
  });

  it('cancels a pending update check before disposing the interactive runtime', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent');
    await mkdir(cwd, { recursive: true });
    interactive.deferUpdateCheck = true;

    await runLocalFelan({ cwd, agentDir });

    expect(interactive.events).toEqual(['init', 'check', 'run', 'check-abort']);
    expect(interactive.updateCheckSignals).toHaveLength(1);
    expect(interactive.updateCheckSignals[0]?.aborted).toBe(true);
    expect(interactive.warnings).toEqual([]);
    expect(interactive.disposals).toBe(1);
  });

  it('disposes the runtime when InteractiveMode construction fails', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent');
    await mkdir(cwd, { recursive: true });
    interactive.constructorError = new Error('constructor failed');

    await expect(runLocalFelan({ cwd, agentDir })).rejects.toThrow('constructor failed');

    expect(interactive.runs).toBe(0);
    expect(interactive.disposals).toBe(1);
  });

  it('forwards verbose startup to Pi while installing the adapter before run', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent');
    await mkdir(cwd, { recursive: true });

    await runLocalFelan({ cwd, agentDir, verbose: true });

    expect(interactive.modeOptions).toEqual([{ verbose: true }]);
    expect(interactive.headerAdapters).toEqual([true]);
  });

  it('disposes the runtime when InteractiveMode.run fails', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent');
    await mkdir(cwd, { recursive: true });
    interactive.runError = new Error('run failed');

    await expect(runLocalFelan({ cwd, agentDir })).rejects.toThrow('run failed');

    expect(interactive.runs).toBe(1);
    expect(interactive.disposals).toBe(1);
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'felan-tui-application-'));
  temporaryPaths.push(path);
  return path;
}
