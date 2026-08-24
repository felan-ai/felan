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
});
