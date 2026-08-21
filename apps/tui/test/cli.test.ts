import { describe, expect, it } from 'vitest';
import { AGENT_CORE_VERSION } from '@felan-ai/agent-core';
import { runCli } from '../src/cli-main.js';
import { FELAN_VERSION } from '../src/version.js';

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
