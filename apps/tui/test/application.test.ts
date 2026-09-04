import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { initTheme } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
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
  constructorStops: [] as number[],
  restartCwd: undefined as string | undefined,
  runError: undefined as Error | undefined,
  runs: 0,
  runCwds: [] as string[],
  stops: 0,
  toolRenderShells: [] as Array<string | undefined>,
  toolNames: [] as string[],
  updateCheckSignals: [] as AbortSignal[],
  updateNotifications: [] as string[],
}));

vi.mock('@earendil-works/pi-coding-agent', async (importOriginal) => {
  const original = await importOriginal<typeof import('@earendil-works/pi-coding-agent')>();
  return {
    ...original,
    InteractiveMode: class {
      builtInHeader: unknown = undefined;
      chatContainer = { addChild: (_component: unknown) => {} };
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
        interactive.constructorStops.push(interactive.stops);
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

      stop() {
        interactive.stops += 1;
      }

      showNewVersionNotification(release: { version: string }) {
        interactive.updateNotifications.push(release.version);
        interactive.events.push('update-notification');
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
import { installFelanTuiCompatibility, normalizeFullscreenTerminalModes } from '../src/tui-compatibility.js';
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
  interactive.constructorStops = [];
  interactive.restartCwd = undefined;
  interactive.runError = undefined;
  interactive.runs = 0;
  interactive.runCwds = [];
  interactive.stops = 0;
  interactive.toolRenderShells = [];
  interactive.toolNames = [];
  interactive.updateCheckSignals = [];
  interactive.updateNotifications = [];
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe('interactive application', () => {
  it('normalizes fullscreen terminal modes without changing ordinary output', () => {
    expect(normalizeFullscreenTerminalModes('ordinary output')).toBe('ordinary output');
    expect(normalizeFullscreenTerminalModes('\x1b[?1049h\x1b[?1003h\x1b[?1006h')).toBe(
      '\x1b[?1006l\x1b[?1004l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?1007l\x1b[?1049h\x1b[?1003h\x1b[?1006h',
    );
    expect(normalizeFullscreenTerminalModes('\x1b[?1049l')).toBe('\x1b[?1049l');
  });

  it('hides expected Pi compaction cancellation noise', () => {
    const statuses: string[] = [];
    const errors: string[] = [];
    const mode = {
      showStatus: (message: string) => statuses.push(message),
      showError: (message: string) => errors.push(message),
    } as unknown as Parameters<typeof installFelanTuiCompatibility>[0];

    installFelanTuiCompatibility(mode, 'darwin');
    const internals = mode as unknown as {
      showStatus(message: string): void;
      showError(message: string): void;
    };
    internals.showStatus('Auto-compaction cancelled');
    internals.showStatus('Other status');
    internals.showError('Compaction failed: Turn prefix summarization failed: This operation was aborted');
    internals.showError('Compaction failed: Provider unavailable');

    expect(statuses).toEqual(['Other status']);
    expect(errors).toEqual(['Compaction failed: Provider unavailable']);
  });

  it('uses a stable, theme-colored Felan mark as the default working indicator', () => {
    initTheme('dark');
    const indicators: Array<{ frames?: string[]; intervalMs?: number } | undefined> = [];
    const onThemeChanged = vi.fn();
    const themeController = { onChanged: onThemeChanged };
    const mode = {
      setWorkingIndicator: (options?: { frames?: string[]; intervalMs?: number }) => {
        indicators.push(options);
      },
      themeController,
    } as unknown as Parameters<typeof installFelanTuiCompatibility>[0];

    installFelanTuiCompatibility(mode, 'darwin');
    const setWorkingIndicator = (mode as unknown as {
      setWorkingIndicator(options?: { frames?: string[]; intervalMs?: number }): void;
    }).setWorkingIndicator;
    const darkFrames = indicators[0]?.frames;

    expect(darkFrames?.map(stripVTControlCharacters)).toEqual([
      '⠐◉ ', '⠈◉ ', ' ◉⠁', ' ◉⠂', ' ◉⠄', '⠠◉ ',
    ]);
    expect(darkFrames?.map(visibleWidth)).toEqual([3, 3, 3, 3, 3, 3]);
    expect(darkFrames?.every((frame) => frame.includes('\x1b['))).toBe(true);
    expect(indicators[0]?.intervalMs).toBe(120);

    setWorkingIndicator({ frames: ['custom'], intervalMs: 50 });
    themeController.onChanged();
    expect(onThemeChanged).toHaveBeenCalledOnce();
    expect(indicators).toHaveLength(2);

    setWorkingIndicator();
    initTheme('light');
    themeController.onChanged();

    const lightFrames = indicators[3]?.frames;
    expect(indicators[1]).toEqual({ frames: ['custom'], intervalMs: 50 });
    expect(lightFrames?.map(stripVTControlCharacters)).toEqual([
      '⠐◉ ', '⠈◉ ', ' ◉⠁', ' ◉⠂', ' ◉⠄', '⠠◉ ',
    ]);
    expect(lightFrames).not.toEqual(darkFrames);
    expect(onThemeChanged).toHaveBeenCalledTimes(2);
    initTheme('dark');
  });

  it('reasserts fullscreen mouse tracking after Windows raw input initialization', () => {
    const events: string[] = [];
    const terminal = {
      write: (data: string) => events.push(`write:${data}`),
      start: () => events.push('start'),
    };
    const mode = {
      renderer: { mode: 'fullscreen', terminal },
    } as unknown as Parameters<typeof installFelanTuiCompatibility>[0];
    const previousTerm = process.env.TERM;
    const previousTmux = process.env.TMUX;
    const previousZellij = process.env.ZELLIJ;
    const previousSty = process.env.STY;
    process.env.TERM = 'xterm-256color';
    delete process.env.TMUX;
    delete process.env.ZELLIJ;
    delete process.env.STY;

    try {
      installFelanTuiCompatibility(mode, 'win32');
      terminal.start(vi.fn(), vi.fn());
    } finally {
      restoreEnvironment('TERM', previousTerm);
      restoreEnvironment('TMUX', previousTmux);
      restoreEnvironment('ZELLIJ', previousZellij);
      restoreEnvironment('STY', previousSty);
    }

    expect(events).toEqual([
      'start',
      'write:\x1b[?1006l\x1b[?1004l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?1007l\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1004h\x1b[?1006h',
    ]);
  });

  it('defers live TUI mode switching and reports activation failures', async () => {
    const writes: string[] = [];
    const errors: string[] = [];
    const switchTuiMode = vi.fn(() => {
      throw new Error('test activation failure');
    });
    const mode = {
      renderer: { terminal: { write: (data: string) => writes.push(data) } },
      switchTuiMode,
      showError: (message: string) => errors.push(message),
    } as unknown as Parameters<typeof installFelanTuiCompatibility>[0];

    installFelanTuiCompatibility(mode, 'win32');
    expect(mode).toBeDefined();
    const wrappedSwitch = (mode as unknown as { switchTuiMode: () => boolean }).switchTuiMode;
    expect(wrappedSwitch()).toBe(true);
    expect(switchTuiMode).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(switchTuiMode).toHaveBeenCalledOnce();
    expect(errors).toEqual(['Could not switch TUI mode: test activation failure']);
    expect(writes).toEqual([]);
  });

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
    expect(interactive.stops).toBe(1);
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

    expect(interactive.events).toEqual(['init', 'check', 'run', 'update-notification']);
    expect(interactive.updateNotifications).toEqual(['0.13.2']);
  });

  it('restarts in a new cwd only after stopping the previous mode and disposing its runtime', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const targetCwd = join(root, 'target');
    const agentDir = join(root, 'agent');
    await Promise.all([cwd, targetCwd].map((path) => mkdir(path, { recursive: true })));
    interactive.restartCwd = targetCwd;

    await runLocalFelan({ cwd, agentDir, initialMessage: 'only the first session' });

    expect(interactive.runCwds).toEqual([cwd, targetCwd]);
    expect(interactive.constructorStops).toEqual([0, 1]);
    expect(interactive.constructorDisposals).toEqual([0, 1]);
    expect(interactive.stops).toBe(2);
    expect(interactive.disposals).toBe(2);
    expect(interactive.modeOptions).toEqual([
      { initialMessage: 'only the first session', tuiMode: 'fullscreen', initialThemeSetting: 'felan-light/felan-dark' },
      { tuiMode: 'fullscreen', initialThemeSetting: 'felan-light/felan-dark' },
    ]);
  });

  it('starts new installs in fullscreen mode while preserving saved TUI mode', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent');
    await mkdir(cwd, { recursive: true });

    await runLocalFelan({ cwd, agentDir });
    expect(interactive.modeOptions[0]).toEqual(expect.objectContaining({ tuiMode: 'fullscreen' }));

    interactive.modeOptions = [];
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ tuiMode: 'regular' }));
    await runLocalFelan({ cwd, agentDir });
    expect(interactive.modeOptions[0]).toEqual(expect.objectContaining({ tuiMode: 'regular' }));

    interactive.modeOptions = [];
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ tuiMode: 'fullscreen' }));
    await runLocalFelan({ cwd, agentDir });
    expect(interactive.modeOptions[0]).toEqual(expect.objectContaining({ tuiMode: 'fullscreen' }));
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
    expect(interactive.updateNotifications).toEqual([]);
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
    expect(interactive.stops).toBe(0);
    expect(interactive.disposals).toBe(1);
  });

  it('forwards verbose startup to Pi while installing the adapter before run', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent');
    await mkdir(cwd, { recursive: true });

    await runLocalFelan({ cwd, agentDir, verbose: true });

    expect(interactive.modeOptions).toEqual([{ verbose: true, tuiMode: 'fullscreen', initialThemeSetting: 'felan-light/felan-dark' }]);
    expect(interactive.headerAdapters).toEqual([true]);
  });

  it('forwards non-info runtime diagnostics as visible startup notices', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent');
    await Promise.all([cwd, agentDir].map((path) => mkdir(path, { recursive: true })));
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({
      extensionConfig: { prewalk: { entryApproval: 'always' } },
    }));

    await runLocalFelan({ cwd, agentDir });

    expect(interactive.modeOptions).toEqual([{
      tuiMode: 'fullscreen',
      initialThemeSetting: 'felan-light/felan-dark',
      startupDiagnostics: [{
        type: 'warning',
        message: 'settings.json.extensionConfig.prewalk.entryApproval must be one of: ask, allow, deny; using the default value.',
      }],
    }]);
  });

  it('disposes the runtime when InteractiveMode.run fails', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent');
    await mkdir(cwd, { recursive: true });
    interactive.runError = new Error('run failed');

    await expect(runLocalFelan({ cwd, agentDir })).rejects.toThrow('run failed');

    expect(interactive.runs).toBe(1);
    expect(interactive.stops).toBe(1);
    expect(interactive.disposals).toBe(1);
  });
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'felan-tui-application-'));
  temporaryPaths.push(path);
  return path;
}
