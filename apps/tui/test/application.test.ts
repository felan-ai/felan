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
  constructorDisposals: [] as number[],
  restartCwd: undefined as string | undefined,
  runError: undefined as Error | undefined,
  runs: 0,
  runCwds: [] as string[],
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
      defaultEditor = {
        onSubmit: undefined as ((text: string) => void) | undefined,
        addToHistory: vi.fn(),
        setText: vi.fn(),
      };
      editor = this.defaultEditor;

      constructor(
        private runtime: InstanceType<typeof original.AgentSessionRuntime>,
        options?: unknown,
      ) {
        interactive.agentDirs.push(process.env.PI_CODING_AGENT_DIR);
        interactive.piTelemetry.push(process.env.PI_TELEMETRY);
        interactive.piVersionChecks.push(process.env.PI_SKIP_VERSION_CHECK);
        interactive.modeOptions.push(options);
        interactive.constructorDisposals.push(interactive.disposals);
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

      createBaseAutocompleteProvider() {
        return {
          triggerCharacters: [],
          getSuggestions: async () => null,
          applyCompletion: (lines: string[], cursorLine: number, cursorCol: number) => ({
            lines,
            cursorLine,
            cursorCol,
          }),
        };
      }

      async getUserInput() {
        return '';
      }

      setupEditorSubmitHandler() {
        this.defaultEditor.onSubmit = () => {};
      }

      async run() {
        interactive.runs += 1;
        interactive.events.push('run');
        interactive.runCwds.push(this.runtime.cwd);
        interactive.headerAdapters.push(
          typeof Object.getOwnPropertyDescriptor(this, 'builtInHeader')?.get === 'function',
        );
        interactive.toolRenderShells.push(this.runtime.session.getToolDefinition('read')?.renderShell);
        interactive.toolNames = this.runtime.session.agent.state.tools.map((tool) => tool.name);
        if (interactive.restartCwd && interactive.runs === 1) {
          throw new CwdChangeRequested(interactive.restartCwd);
        }
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

import { brandResumeHint, runLocalFelan } from '../src/application.js';
import { CwdChangeRequested } from '../src/cwd-command.js';

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
  interactive.constructorDisposals = [];
  interactive.restartCwd = undefined;
  interactive.runError = undefined;
  interactive.runs = 0;
  interactive.runCwds = [];
  interactive.toolRenderShells = [];
  interactive.toolNames = [];
  interactive.updateCheckSignals = [];
  interactive.warnings = [];
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe('interactive application', () => {
  it('brands Pi resume hints and omits the default Felan session directory', () => {
    const resumeHint = "To resume this session: pi --session-dir 'C:\\Users\\35988\\.felan\\sessions' --session 01a033a6-db3c-7094-993f-0aad3b3dadfd\n";
    expect(brandResumeHint(resumeHint, true)).toBe(
      'To resume this session: felan --session 01a033a6-db3c-7094-993f-0aad3b3dadfd\n',
    );
    expect(brandResumeHint(resumeHint)).toBe(
      "To resume this session: felan --session-dir 'C:\\Users\\35988\\.felan\\sessions' --session 01a033a6-db3c-7094-993f-0aad3b3dadfd\n",
    );
    expect(brandResumeHint('ordinary output\n')).toBe('ordinary output\n');
    expect(brandResumeHint(
      "\x1b[2mTo resume this session:\x1b[22m pi --session-dir '/tmp/felan --session archives' --session session-id\n",
      true,
    )).toBe(
      '\x1b[2mTo resume this session:\x1b[22m felan --session session-id\n',
    );
  });

  it('runs Pi InteractiveMode with the composed local Agent Core runtime', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent');
    const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousPiSkipVersionCheck = process.env.PI_SKIP_VERSION_CHECK;
    const previousPiTelemetry = process.env.PI_TELEMETRY;
    const previousStdoutWrite = process.stdout.write;
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
    expect(process.stdout.write).toBe(previousStdoutWrite);
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

  it('restarts in a new cwd only after disposing the previous runtime', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const targetCwd = join(root, 'target');
    const agentDir = join(root, 'agent');
    await Promise.all([cwd, targetCwd].map((path) => mkdir(path, { recursive: true })));
    interactive.restartCwd = targetCwd;

    await runLocalFelan({ cwd, agentDir, initialMessage: 'only the first session' });

    expect(interactive.runCwds).toEqual([cwd, targetCwd]);
    expect(interactive.constructorDisposals).toEqual([0, 1]);
    expect(interactive.disposals).toBe(2);
    expect(interactive.modeOptions).toEqual([
      { initialMessage: 'only the first session' },
      {},
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
