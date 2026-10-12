import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGENT_CORE_VERSION, SessionManager } from '@felan-ai/agent-core';
import { runCli } from '../src/cli-main.js';
import { FELAN_VERSION } from '../src/version.js';
import type { RunDaemonFelanOptions } from '../src/client-application.js';

afterEach(() => vi.restoreAllMocks());

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

  it('runs ACP without starting the interactive or one-shot application', async () => {
    let acpLaunches = 0;
    let launched = false;

    const exitCode = await runCli(['acp'], {
      launchAcp: async () => {
        acpLaunches += 1;
        return 7;
      },
      launch: async () => { launched = true; },
      launchHeadless: async () => { launched = true; return 1; },
    });

    expect(exitCode).toBe(7);
    expect(acpLaunches).toBe(1);
    expect(launched).toBe(false);
  });

  it('runs finite ACP login without starting the ACP server or agent application', async () => {
    let loginLaunches = 0;
    let launched = false;

    const exitCode = await runCli(['acp', 'login'], {
      launchAcpLogin: async () => {
        loginLaunches += 1;
        return 7;
      },
      launchAcp: async () => { launched = true; return 1; },
      launch: async () => { launched = true; },
      launchHeadless: async () => { launched = true; return 1; },
    });

    expect(exitCode).toBe(7);
    expect(loginLaunches).toBe(1);
    expect(launched).toBe(false);
  });

  it('keeps ACP after -- as a prompt and rejects it as a headless output mode', async () => {
    const launches: RunDaemonFelanOptions[] = [];
    const errors: string[] = [];

    expect(await runCli(['--', 'acp'], {
      launch: async (options) => launches.push(options),
    })).toBe(0);
    expect(await runCli(['--mode', 'acp', 'prompt'], {
      writeError: (line) => errors.push(line),
    })).toBe(1);

    expect(launches).toEqual([{
      continueRecent: false,
      verbose: false,
      initialMessage: 'acp',
    }]);
    expect(errors).toEqual(['--mode requires text or json']);
  });

  it('forwards the client agent directory and isolated daemon to ACP login', async () => {
    const launches: unknown[] = [];
    const exitCode = await runCli(['acp', 'login', '--daemon-runtime', '/tmp/felan-login-isolated'], {
      launchAcpLogin: async options => { launches.push(options); return 0; },
    });
    expect(exitCode).toBe(0);
    expect(launches).toEqual([expect.objectContaining({ agentDir: expect.any(String), daemonRuntime: '/tmp/felan-login-isolated' })]);
  });

  it('forwards headless session overrides and isolated target without local runtime option conversion', async () => {
    const launches: unknown[] = [];
    const open = vi.spyOn(SessionManager, 'open').mockImplementation(() => { throw new Error('Client must not read session files'); });
    expect(await runCli(['--mode', 'text', '--session', 'known', '--daemon-runtime', '/tmp/felan-headless-isolated', '--codex-fast', 'hello'], {
      launchHeadless: async options => { launches.push(options); return 0; },
    })).toBe(0);
    expect(open).not.toHaveBeenCalled();
    expect(launches).toEqual([expect.objectContaining({ sessionId: 'known', daemonRuntime: '/tmp/felan-headless-isolated', config: { 'codex-fast': true } })]);
    expect(launches[0]).not.toHaveProperty('extensionConfigOverrides');
  });

  it('shows ACP help and rejects ACP arguments before launch', async () => {
    const output: string[] = [];
    const errors: string[] = [];
    let launched = false;

    expect(await runCli(['acp', '--help'], {
      writeOutput: (line) => output.push(line),
      launchAcp: async () => { launched = true; return 0; },
    })).toBe(0);
    expect(await runCli(['acp', '--unknown'], {
      writeError: (line) => errors.push(line),
      launchAcp: async () => { launched = true; return 0; },
    })).toBe(1);

    expect(output).toEqual(['Usage: felan acp [login]']);
    expect(errors).toEqual(['Usage: felan acp [login]']);
    expect(launched).toBe(false);
  });

  it('shows finite ACP login help and rejects extra login arguments', async () => {
    const output: string[] = [];
    const errors: string[] = [];
    let launched = false;

    expect(await runCli(['acp', 'login', '--help'], {
      writeOutput: (line) => output.push(line),
      launchAcpLogin: async () => { launched = true; return 0; },
    })).toBe(0);
    expect(await runCli(['acp', 'login', '--unknown'], {
      writeError: (line) => errors.push(line),
      launchAcpLogin: async () => { launched = true; return 0; },
    })).toBe(1);

    expect(output).toEqual(['Usage: felan acp login']);
    expect(errors).toEqual(['Usage: felan acp login']);
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
    expect(output).toContain(`Felan Code version: ${FELAN_VERSION}`);
    expect(output).toContain(`Agent Core version: ${AGENT_CORE_VERSION}`);
    expect(output).toContain('Runtime: local daemon client');
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

  it('passes explicit creation configuration without turning the prompt into restart arguments', async () => {
    const launches: RunDaemonFelanOptions[] = [];

    const exitCode = await runCli([
      '--continue',
      '--verbose',
      '--prewalk-entry-approval', 'allow',
      'do', 'not', 'replay', 'this',
    ], { launch: async (options) => launches.push(options) });

    expect(exitCode).toBe(0);
    expect(launches[0]?.config).toEqual({ 'prewalk-entry-approval': 'allow' });
    expect(launches[0]?.initialMessage).toBe('do not replay this');
  });

  it('passes repeatable local Pi extension paths to interactive launch and restart', async () => {
    const launches: RunDaemonFelanOptions[] = [];
    const exitCode = await runCli([
      '--extension', './first-extension.ts',
      '-e', '~/second-extension.ts',
      'inspect',
    ], { launch: async (options) => launches.push(options) });

    expect(exitCode).toBe(0);
    expect(launches[0]?.extensionPaths).toEqual([
      resolve(process.cwd(), 'first-extension.ts'),
      resolve(homedir(), 'second-extension.ts'),
    ]);
  });

  it('rejects non-local or headless Pi extension paths', async () => {
    const errors: string[] = [];
    expect(await runCli(['--extension', 'npm:@example/extension'], {
      writeError: (line) => errors.push(line),
    })).toBe(1);
    expect(await runCli(['--mode', 'text', '-e', './extension.ts', 'inspect'], {
      writeError: (line) => errors.push(line),
    })).toBe(1);
    expect(await runCli(['-e'], {
      writeError: (line) => errors.push(line),
    })).toBe(1);
    expect(errors).toEqual([
      'Extension source must be a local file or directory: npm:@example/extension',
      '--extension is interactive-only',
      '-e requires a local extension path',
    ]);
  });

  it('delegates both resume aliases to the daemon-backed terminal picker', async () => {
    for (const argument of ['-r', '--resume']) {
      const launches: RunDaemonFelanOptions[] = [];

      const exitCode = await runCli([argument], {
        launch: async (options) => launches.push(options),
      });

      expect(exitCode).toBe(0);
      expect(launches).toEqual([{
        continueRecent: false,
        verbose: false,
        resume: true,
      }]);
    }
  });

  it('does not consult a local session reader before launching the remote picker', async () => {
    let launched = false;
    const open = vi.spyOn(SessionManager, 'open').mockImplementation(() => { throw new Error('Local session reads are forbidden in the TUI path'); });

    const exitCode = await runCli(['--resume'], {
      launch: async () => { launched = true; },
    });

    expect(exitCode).toBe(0);
    expect(open).not.toHaveBeenCalled();
    expect(launched).toBe(true);
  });

  it('passes a specific session and optional directory without opening its file', async () => {
    const open = vi.spyOn(SessionManager, 'open').mockImplementation(() => { throw new Error('Unexpected local session access'); });
    const launches: RunDaemonFelanOptions[] = [];

    const exitCode = await runCli([
      '--session-dir', 'C:\\Users\\35988\\.felan\\sessions',
      '--session', '01a033a6-db3c-7094-993f-0aad3b3dadfd',
    ], {
      launch: async (options) => launches.push(options),
    });

    expect(exitCode).toBe(0);
    expect(open).not.toHaveBeenCalled();
    expect(launches[0]).toMatchObject({
      sessionId: '01a033a6-db3c-7094-993f-0aad3b3dadfd',
      sessionDir: 'C:\\Users\\35988\\.felan\\sessions',
    });
  });

  it('delegates missing-session lookup and fallback to the daemon-backed controller', async () => {
    const launches: RunDaemonFelanOptions[] = [];
    const root = await mkdtemp(join(tmpdir(), 'felan-cli-'));
    const sessionDir = join(root, 'missing-sessions');

    const exitCode = await runCli([
      '--session-dir', sessionDir,
      '--session', '01a07c3c-8baf-7219-87e5-6ab6f35cc3bb',
    ], { launch: async (options) => launches.push(options) }).finally(
      () => rm(root, { force: true, recursive: true }),
    );

    expect(exitCode).toBe(0);
    expect(launches).toEqual([{
      continueRecent: false,
      verbose: false,
      sessionDir,
      sessionId: '01a07c3c-8baf-7219-87e5-6ab6f35cc3bb',
    }]);
  });

  it('forwards headless session identity without consulting local session files', async () => {
    const errors: string[] = [];
    const launches: unknown[] = [];
    const root = await mkdtemp(join(tmpdir(), 'felan-cli-'));
    const sessionDir = join(root, 'missing-sessions');
    const open = vi.spyOn(SessionManager, 'open').mockImplementation(() => { throw new Error('Client session-file access is forbidden'); });

    const exitCode = await runCli([
      '--mode', 'text',
      '--session-dir', sessionDir,
      '--session', 'missing',
      'inspect', 'this',
    ], {
      writeError: (line) => errors.push(line),
      launchHeadless: async (options) => {
        launches.push(options);
        return 7;
      },
    }).finally(() => rm(root, { force: true, recursive: true }));

    expect(exitCode).toBe(7);
    expect(open).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
    expect(launches).toEqual([{
      mode: 'text',
      initialMessage: 'inspect this',
      continueRecent: false,
      sessionId: 'missing',
      sessionDir,
    }]);
  });

  it('rejects conflicting resume flags before selection or launch', async () => {
    const errors: string[] = [];
    let launched = false;

    const exitCode = await runCli(['--continue', '--resume'], {
      writeError: (line) => errors.push(line),
      launch: async () => { launched = true; },
    });

    expect(exitCode).toBe(1);
    expect(errors).toEqual(['Cannot combine --continue with --resume or --session']);
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

  it('requires explicit absolute isolated daemon selection and forwards it to the client', async () => {
    const launches: RunDaemonFelanOptions[] = []; const errors: string[] = [];
    expect(await runCli(['--daemon-runtime', 'relative'], { writeError: line => errors.push(line) })).toBe(1);
    expect(await runCli(['--daemon-runtime', '/tmp/felan-fixture'], { launch: async options => { launches.push(options); } })).toBe(0);
    expect(errors).toEqual(['--daemon-runtime requires an absolute isolated directory']);
    expect(launches[0]?.daemonRuntime).toBe('/tmp/felan-fixture');
  });

  it('reports terminal connection failures without falling back to an in-process runtime', async () => {
    const errors: string[] = [];
    expect(await runCli([], { launch: async () => { throw new Error('daemon unavailable'); }, writeError: line => errors.push(line) })).toBe(1);
    expect(errors).toEqual(['daemon unavailable']);
  });

  it('parses declarative extension options and passes them to the runtime', async () => {
    const launches: RunDaemonFelanOptions[] = [];
    const exitCode = await runCli([
      '--prewalk-entry-approval', 'allow',
      '--no-prewalk-restore-planner',
      '--powerline-style=capsule',
      'inspect',
    ], { launch: async (options) => launches.push(options) });

    expect(exitCode).toBe(0);
    expect(launches[0]?.config).toEqual({ 'prewalk-entry-approval': 'allow', 'prewalk-restore-planner': false, 'powerline-style': 'capsule' });
  });

  it('parses ask-user configuration options', async () => {
    const launches: RunDaemonFelanOptions[] = [];
    const exitCode = await runCli([
      '--ask-user-display-mode', 'overlay',
      '--ask-user-single-select-layout', 'list',
      '--ask-user-overlay-toggle-key', 'off',
      '--ask-user-comment-toggle-key', 'ctrl+x',
      'inspect',
    ], { launch: async (options) => launches.push(options) });

    expect(exitCode).toBe(0);
    expect(launches[0]?.config).toEqual({ 'ask-user-display-mode': 'overlay', 'ask-user-single-select-layout': 'list',
      'ask-user-overlay-toggle-key': 'off', 'ask-user-comment-toggle-key': 'ctrl+x' });
  });

  it('parses context-view configuration options', async () => {
    const launches: RunDaemonFelanOptions[] = [];
    const exitCode = await runCli([
      '--context-view-display-mode', 'overlay',
      'inspect',
    ], { launch: async (options) => launches.push(options) });

    expect(exitCode).toBe(0);
    expect(launches[0]?.config).toEqual({ 'context-view-display-mode': 'overlay' });
  });

  it('parses browser authorization configuration options', async () => {
    const launches: RunDaemonFelanOptions[] = [];
    const exitCode = await runCli(['--browser-authorization-policy', 'always-allow', 'inspect'], {
      launch: async (options) => launches.push(options),
    });

    expect(exitCode).toBe(0);
    expect(launches[0]?.config).toEqual({ 'browser-authorization-policy': 'always-allow' });
  });

  it('parses Tasks display configuration options', async () => {
    const launches: RunDaemonFelanOptions[] = [];
    const exitCode = await runCli([
      '--tasks-display-mode', 'overlay',
      'inspect',
    ], { launch: async (options) => launches.push(options) });

    expect(exitCode).toBe(0);
    expect(launches[0]?.config).toEqual({ 'tasks-display-mode': 'overlay' });
  });

  it('parses session-compaction model configuration options', async () => {
    const launches: RunDaemonFelanOptions[] = [];
    const exitCode = await runCli([
      '--session-compaction-model', 'low',
      'inspect',
    ], { launch: async (options) => launches.push(options) });

    expect(exitCode).toBe(0);
    expect(launches[0]?.config).toEqual({ 'session-compaction-model': 'low' });
  });

  it('parses structured declarative extension options as JSON', async () => {
    const launches: RunDaemonFelanOptions[] = [];
    const lines = '[{"segments":{"status":{"enabled":true}}}]';
    const exitCode = await runCli([
      `--powerline-lines=${lines}`,
      'inspect',
    ], { launch: async (options) => launches.push(options) });

    expect(exitCode).toBe(0);
    expect(launches[0]?.config).toEqual({ 'powerline-lines': [{ segments: { status: { enabled: true } } }] });
  });

  it.each(['minimal', 'high'] as const)('routes text and JSON modes with %s thinking to the headless launcher', async (thinkingLevel) => {
    const launches: unknown[] = [];
    const exitCode = await runCli([
      '--mode', 'json',
      '--provider', 'openai',
      '--model', 'gpt-test',
      '--thinking', thinkingLevel,
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
      thinkingLevel,
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
    })).toBe(1);

    expect(errors).toEqual([
      '--mode requires text or json',
      'Invalid thinking level "invalid". Valid values: off|minimal|low|medium|high|xhigh|max',
      '--resume is interactive-only; use --continue or --session in headless mode',
    ]);
  });
});
