import { describe, expect, it } from 'vitest';
import { AGENT_CORE_VERSION } from '@felan-ai/agent-core';
import { runCli } from '../src/cli-main.js';
import { FELAN_VERSION } from '../src/version.js';

describe('felan CLI', () => {
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
