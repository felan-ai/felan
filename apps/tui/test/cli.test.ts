import { describe, expect, it } from 'vitest';
import { AGENT_CORE_VERSION } from '@felan-ai/agent-core';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { runCli } from '../src/cli-main.js';
import { FELAN_VERSION } from '../src/version.js';
import type { RunLocalFelanOptions } from '../src/application.js';

describe('felan CLI', () => {
  it('runs update without starting the interactive application', async () => {
    let launched = false;
    let updated = false;

    const exitCode = await runCli(['update'], {
      update: async () => {
        updated = true;
        return 7;
      },
      launch: async () => {
        launched = true;
      },
    });

    expect(exitCode).toBe(7);
    expect(updated).toBe(true);
    expect(launched).toBe(false);
  });

  it('runs savings without starting a model session', async () => {
    const output: string[] = [];
    let launched = false;
    const exitCode = await runCli(['savings', '--help'], {
      writeOutput: (line) => output.push(line),
      launch: async () => { launched = true; },
      launchHeadless: async () => { launched = true; return 1; },
    });

    expect(exitCode).toBe(0);
    expect(launched).toBe(false);
    expect(output[0]).toContain('Usage: felan savings');
  });

  it('validates savings options before reading storage', async () => {
    const errors: string[] = [];
    expect(await runCli(['savings', '--project', '--session', 'session'], {
      writeError: (line) => errors.push(line),
    })).toBe(1);
    expect(await runCli(['savings', '--format', 'yaml'], {
      writeError: (line) => errors.push(line),
    })).toBe(1);
    expect(errors).toEqual([
      'Cannot combine --project with --session',
      '--format requires text or json',
    ]);
  });

  it('rejects extra update arguments without starting the interactive application', async () => {
    const errors: string[] = [];
    let launched = false;
    let updated = false;

    const exitCode = await runCli(['update', '--help'], {
      writeError: (line) => errors.push(line),
      update: async () => {
        updated = true;
        return 0;
      },
      launch: async () => {
        launched = true;
      },
    });

    expect(exitCode).toBe(1);
    expect(errors).toEqual(['Usage: felan update']);
    expect(updated).toBe(false);
    expect(launched).toBe(false);
  });

  it('keeps -- update as an initial interactive message', async () => {
    const launches: unknown[] = [];
    let updated = false;

    const exitCode = await runCli(['--', 'update'], {
      update: async () => {
        updated = true;
        return 0;
      },
      launch: async (options) => {
        launches.push(options);
      },
    });

    expect(exitCode).toBe(0);
    expect(updated).toBe(false);
    expect(launches).toEqual([{
      continueRecent: false,
      verbose: false,
      initialMessage: 'update',
    }]);
  });

  it('reports Felan and Agent Core versions in diagnostics', async () => {
    const output: string[] = [];

    const exitCode = await runCli(['--diagnostics'], {
      writeOutput: (line) => output.push(line),
    });

    expect(exitCode).toBe(0);
    expect(output).toContain(`Felan version: ${FELAN_VERSION}`);
    expect(output).toContain(`Agent Core version: ${AGENT_CORE_VERSION}`);
    expect(output).toContain('Runtime: host');
    expect(output).toContain('Credentials: local');
  });

  it('passes continue, verbosity, and initial input to the interactive application', async () => {
    const launches: unknown[] = [];

    const exitCode = await runCli(['--continue', '--verbose', 'inspect', 'this project'], {
      launch: async (options) => {
        launches.push(options);
      },
    });

    expect(exitCode).toBe(0);
    expect(launches).toEqual([{
      continueRecent: true,
      verbose: true,
      initialMessage: 'inspect this project',
    }]);
  });

  it('opens the session picker for both resume aliases', async () => {
    for (const argument of ['-r', '--resume']) {
      const sessionManager = SessionManager.inMemory('/stored/project');
      const launches: RunLocalFelanOptions[] = [];

      const exitCode = await runCli([argument], {
        pickSession: async () => sessionManager,
        launch: async (options) => launches.push(options),
      });

      expect(exitCode).toBe(0);
      expect(launches).toEqual([{
        continueRecent: false,
        verbose: false,
        sessionManager,
      }]);
    }
  });

  it('exits without launching when session selection is cancelled', async () => {
    let launched = false;

    const exitCode = await runCli(['--resume'], {
      pickSession: async () => undefined,
      launch: async () => { launched = true; },
    });

    expect(exitCode).toBe(0);
    expect(launched).toBe(false);
  });

  it('opens a specific session with its optional directory', async () => {
    const sessionManager = SessionManager.inMemory('/stored/project');
    const opened: unknown[] = [];
    const launches: RunLocalFelanOptions[] = [];

    const exitCode = await runCli([
      '--session-dir', 'C:\\Users\\35988\\.felan\\sessions',
      '--session', '01a033a6-db3c-7094-993f-0aad3b3dadfd',
    ], {
      openSession: async (id, sessionDir) => {
        opened.push({ id, sessionDir });
        return sessionManager;
      },
      launch: async (options) => launches.push(options),
    });

    expect(exitCode).toBe(0);
    expect(opened).toEqual([{
      id: '01a033a6-db3c-7094-993f-0aad3b3dadfd',
      sessionDir: 'C:\\Users\\35988\\.felan\\sessions',
    }]);
    expect(launches[0]?.sessionManager).toBe(sessionManager);
  });

  it('rejects conflicting resume flags before selection or launch', async () => {
    const errors: string[] = [];
    let picked = false;
    let launched = false;

    const exitCode = await runCli(['--continue', '--resume'], {
      writeError: (line) => errors.push(line),
      pickSession: async () => {
        picked = true;
        return undefined;
      },
      launch: async () => { launched = true; },
    });

    expect(exitCode).toBe(1);
    expect(errors).toEqual(['Cannot combine --continue with --resume or --session']);
    expect(picked).toBe(false);
    expect(launched).toBe(false);
  });

  it('does not consume another option as a session argument', async () => {
    const errors: string[] = [];

    expect(await runCli(['--session', '--continue'], {
      writeError: (line) => errors.push(line),
    })).toBe(1);
    expect(await runCli(['--session-dir', '--help'], {
      writeError: (line) => errors.push(line),
    })).toBe(1);

    expect(errors).toEqual([
      '--session requires an id',
      '--session-dir requires a directory',
    ]);
  });

  it('rejects unknown options before starting the TUI', async () => {
    const errors: string[] = [];
    let launched = false;

    const exitCode = await runCli(['--cloud'], {
      writeError: (line) => errors.push(line),
      launch: async () => {
        launched = true;
      },
    });

    expect(exitCode).toBe(1);
    expect(errors).toEqual(['Unknown option: --cloud']);
    expect(launched).toBe(false);
  });

  it('parses declarative extension options and passes them to the runtime', async () => {
    const launches: RunLocalFelanOptions[] = [];
    const exitCode = await runCli([
      '--prewalk-entry-approval', 'allow',
      '--no-prewalk-restore-planner',
      '--powerline-style=capsule',
      'inspect',
    ], { launch: async (options) => launches.push(options) });

    expect(exitCode).toBe(0);
    expect(launches[0]?.extensionConfigOverrides).toEqual([expect.objectContaining({
      extensionId: 'prewalk', values: { entryApproval: 'allow', restorePlanner: false },
    }), expect.objectContaining({ extensionId: 'powerline', values: { style: 'capsule' } })]);
  });

  it('parses ask-user configuration options', async () => {
    const launches: RunLocalFelanOptions[] = [];
    const exitCode = await runCli([
      '--ask-user-display-mode', 'overlay',
      '--ask-user-single-select-layout', 'list',
      '--ask-user-overlay-toggle-key', 'off',
      '--ask-user-comment-toggle-key', 'ctrl+x',
      'inspect',
    ], { launch: async (options) => launches.push(options) });

    expect(exitCode).toBe(0);
    expect(launches[0]?.extensionConfigOverrides).toEqual([expect.objectContaining({
      extensionId: 'askUser',
      values: {
        displayMode: 'overlay',
        singleSelectLayout: 'list',
        overlayToggleKey: 'off',
        commentToggleKey: 'ctrl+x',
      },
    })]);
  });

  it('parses context-view configuration options', async () => {
    const launches: RunLocalFelanOptions[] = [];
    const exitCode = await runCli([
      '--context-view-display-mode', 'overlay',
      'inspect',
    ], { launch: async (options) => launches.push(options) });

    expect(exitCode).toBe(0);
    expect(launches[0]?.extensionConfigOverrides).toEqual([expect.objectContaining({
      extensionId: 'contextView',
      values: { displayMode: 'overlay' },
    })]);
  });

  it('parses Tasks display configuration options', async () => {
    const launches: RunLocalFelanOptions[] = [];
    const exitCode = await runCli([
      '--tasks-display-mode', 'overlay',
      'inspect',
    ], { launch: async (options) => launches.push(options) });

    expect(exitCode).toBe(0);
    expect(launches[0]?.extensionConfigOverrides).toEqual([expect.objectContaining({
      extensionId: 'tasks',
      values: { displayMode: 'overlay' },
    })]);
  });

  it('parses structured declarative extension options as JSON', async () => {
    const launches: RunLocalFelanOptions[] = [];
    const lines = '[{"segments":{"status":{"enabled":true}}}]';
    const exitCode = await runCli([
      `--powerline-lines=${lines}`,
      'inspect',
    ], { launch: async (options) => launches.push(options) });

    expect(exitCode).toBe(0);
    expect(launches[0]?.extensionConfigOverrides).toEqual([expect.objectContaining({
      extensionId: 'powerline', values: { lines: [{ segments: { status: { enabled: true } } }] },
    })]);
  });

  it('routes text and JSON modes to the headless launcher with model selection', async () => {
    const launches: unknown[] = [];
    const exitCode = await runCli([
      '--mode', 'json',
      '--provider', 'openai',
      '--model', 'gpt-test',
      '--thinking', 'high',
      '--continue',
      'inspect', 'this',
    ], {
      launchHeadless: async (options) => {
        launches.push(options);
        return 7;
      },
    });

    expect(exitCode).toBe(7);
    expect(launches).toEqual([expect.objectContaining({
      mode: 'json',
      provider: 'openai',
      model: 'gpt-test',
      thinkingLevel: 'high',
      continueRecent: true,
      initialMessage: 'inspect this',
    })]);
  });

  it('requires a prompt for headless mode', async () => {
    const errors: string[] = [];
    let launched = false;

    const exitCode = await runCli(['--mode', 'text'], {
      writeError: (line) => errors.push(line),
      launchHeadless: async () => {
        launched = true;
        return 0;
      },
    });

    expect(exitCode).toBe(1);
    expect(errors).toEqual(['--mode text requires an initial prompt']);
    expect(launched).toBe(false);
  });

  it('validates headless values and rejects the interactive session picker', async () => {
    const errors: string[] = [];
    expect(await runCli(['--mode', 'yaml', 'prompt'], {
      writeError: (line) => errors.push(line),
    })).toBe(1);
    expect(await runCli(['--mode', 'text', '--thinking', 'invalid', 'prompt'], {
      writeError: (line) => errors.push(line),
    })).toBe(1);
    expect(await runCli(['--mode', 'text', '--resume', 'prompt'], {
      writeError: (line) => errors.push(line),
      pickSession: async () => {
        throw new Error('picker should not run');
      },
    })).toBe(1);

    expect(errors).toEqual([
      '--mode requires text or json',
      'Invalid thinking level "invalid". Valid values: off|minimal|low|medium|high|xhigh|max',
      '--resume is interactive-only; use --continue or --session in headless mode',
    ]);
  });
});
