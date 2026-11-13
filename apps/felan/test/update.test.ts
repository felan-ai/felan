import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareDaemonForUpdate, type DaemonUpdatePreparation } from '../src/update-daemon.js';
import {
  checkForFelanUpdate,
  detectFelanInstallation,
  felanUpdateCommand,
  runFelanUpdate,
  type FelanInstallation,
  type NpmResult,
} from '../src/update.js';

vi.mock('../src/update-daemon.js', () => ({ prepareDaemonForUpdate: vi.fn() }));

const temporaryDirectories: string[] = [];
const previousFelanSkipVersionCheck = process.env.FELAN_SKIP_VERSION_CHECK;
const previousPiOffline = process.env.PI_OFFLINE;

beforeEach(() => {
  vi.mocked(prepareDaemonForUpdate).mockReset().mockResolvedValue({ kind: 'absent' });
  delete process.env.FELAN_SKIP_VERSION_CHECK;
  delete process.env.PI_OFFLINE;
});

afterEach(async () => {
  vi.useRealTimers();
  if (previousFelanSkipVersionCheck === undefined) delete process.env.FELAN_SKIP_VERSION_CHECK;
  else process.env.FELAN_SKIP_VERSION_CHECK = previousFelanSkipVersionCheck;
  if (previousPiOffline === undefined) delete process.env.PI_OFFLINE;
  else process.env.PI_OFFLINE = previousPiOffline;
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('Felan Code update availability check', () => {
  it('checks npm once with a bounded request and returns a newer stable release', async () => {
    let requestedUrl: string | undefined;
    let requestInit: RequestInit | undefined;

    const latestVersion = await checkForFelanUpdate({
      currentVersion: '0.13.0',
      timeoutMs: 50,
      fetch: async (input, init) => {
        requestedUrl = String(input);
        requestInit = init;
        return jsonResponse({ version: '0.13.1' });
      },
    });

    expect(latestVersion).toBe('0.13.1');
    expect(requestedUrl).toBe('https://registry.npmjs.org/@felan-ai%2Ffelan/latest');
    expect(new Headers(requestInit?.headers).get('accept')).toBe('application/json');
    expect(new Headers(requestInit?.headers).get('user-agent')).toContain('felan/0.13.0');
    expect(requestInit?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each(['0.13.0', '0.12.9', '0.13.1-next.1', 'not-a-version'])(
    'ignores a non-newer stable release response: %s',
    async (version) => {
      await expect(checkForFelanUpdate({
        currentVersion: '0.13.0',
        fetch: async () => jsonResponse({ version }),
      })).resolves.toBeUndefined();
    },
  );

  it('silently ignores failed and malformed registry responses', async () => {
    await expect(checkForFelanUpdate({
      currentVersion: '0.13.0',
      fetch: async () => new Response('', { status: 503 }),
    })).resolves.toBeUndefined();
    await expect(checkForFelanUpdate({
      currentVersion: '0.13.0',
      fetch: async () => new Response('{', { status: 200 }),
    })).resolves.toBeUndefined();
    await expect(checkForFelanUpdate({
      currentVersion: '0.13.0',
      fetch: async () => { throw new Error('offline'); },
    })).resolves.toBeUndefined();
  });

  it('silently stops a request at the configured timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const checked = expect(checkForFelanUpdate({
      currentVersion: '0.13.0',
      timeoutMs: 5,
      fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) throw new Error('missing abort signal');
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    })).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(5);
    await checked;
  });

  it('honors caller cancellation', async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const check = checkForFelanUpdate({
      currentVersion: '0.13.0',
      signal: controller.signal,
      fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
        requestSignal = init?.signal ?? undefined;
        if (!requestSignal) throw new Error('missing abort signal');
        requestSignal.addEventListener('abort', () => reject(requestSignal?.reason), { once: true });
      }),
    });

    controller.abort();

    await expect(check).resolves.toBeUndefined();
    expect(requestSignal?.aborted).toBe(true);
  });

  it.each(['PI_OFFLINE', 'FELAN_SKIP_VERSION_CHECK'] as const)(
    'skips the request when %s is set',
    async (environmentVariable) => {
      process.env[environmentVariable] = '1';
      let requested = false;

      await expect(checkForFelanUpdate({
        currentVersion: '0.13.0',
        fetch: async () => {
          requested = true;
          return jsonResponse({ version: '0.13.1' });
        },
      })).resolves.toBeUndefined();
      expect(requested).toBe(false);
    },
  );
});

describe('Felan Code installation detection', () => {
  it.each([
    ['/usr/local/lib/node_modules/@felan-ai/felan', 'linux'],
    ['/opt/node/lib/node_modules/@felan-ai/felan/', 'darwin'],
    ['/lib/node_modules/@felan-ai/felan', 'linux'],
    ['C:\\Users\\Alice\\AppData\\Roaming\\npm\\node_modules\\@felan-ai\\felan', 'win32'],
    ['C:/Tools/Node/NODE_MODULES/@FELAN-AI/FELAN', 'win32'],
    ['\\opt\\node\\lib\\node_modules\\@felan-ai\\felan', 'linux'],
  ] as const)('rejects the npm-shaped path %s on %s without a bin link', (path, platform) => {
    const installation = detectFelanInstallation(path, platform);
    expect(installation).toEqual({ kind: 'unknown', packageDirectory: path });
    expect(felanUpdateCommand(installation)).toBeUndefined();
  });

  it.each(['linux', 'darwin', 'win32'] as const)('detects a verified npm prefix on %s', async (platform) => {
    const fixture = await packageFixture('0.12.11', '@felan-ai/felan', platform);
    const installation = detectFelanInstallation(fixture.packageDirectory, platform);
    expect(installation).toEqual({
      kind: 'npm-prefix', packageDirectory: fixture.packageDirectory, prefix: fixture.prefix.replace(/\\/gu, '/'),
    });
    expect(felanUpdateCommand(installation)).toBe('felan update');
  });

  it.each([
    ['/home/alice/.local/share/pnpm/global/5/node_modules/@felan-ai/felan', 'linux', 'pnpm'],
    ['/prefix/lib/node_modules/.pnpm/@felan-ai+felan@0.12.11/node_modules/@felan-ai/felan', 'linux', 'unknown'],
    ['/home/alice/.bun/install/global/node_modules/@felan-ai/felan', 'linux', 'bun'],
    ['/home/alice/.config/yarn/global/node_modules/@felan-ai/felan', 'linux', 'yarn'],
    ['/home/alice/.volta/tools/image/packages/@felan-ai/felan/lib/node_modules/@felan-ai/felan', 'linux', 'volta'],
    ['/home/alice/.npm/_npx/123/node_modules/@felan-ai/felan', 'linux', 'npx'],
    ['C:\\Users\\Alice\\PNPM\\GLOBAL\\5\\node_modules\\@felan-ai\\felan', 'win32', 'pnpm'],
    ['C:\\Users\\Alice\\.BUN\\install\\global\\node_modules\\@felan-ai\\felan', 'win32', 'bun'],
    ['C:\\Users\\Alice\\AppData\\Local\\Yarn\\Data\\global\\node_modules\\@felan-ai\\felan', 'win32', 'yarn'],
    ['C:\\Users\\Alice\\.VOLTA\\tools\\image\\packages\\@felan-ai\\felan', 'win32', 'volta'],
    ['C:\\Users\\Alice\\AppData\\Local\\Volta\\tools\\image\\packages\\@felan-ai\\felan', 'win32', 'volta'],
    ['C:\\Users\\Alice\\npm-cache\\_NPX\\123\\node_modules\\@felan-ai\\felan', 'win32', 'npx'],
    ['/work/felan/apps/felan', 'linux', 'linked'],
    ['C:\\work\\felan\\apps\\felan', 'win32', 'linked'],
    ['/custom/node_modules/@felan-ai/felan', 'linux', 'unknown'],
    ['C:\\proj\\node_modules\\@felan-ai\\felan', 'win32', 'unknown'],
    ['C:\\custom\\modules\\node_modules\\other', 'win32', 'unknown'],
    ['/prefix/lib/NODE_MODULES/@felan-ai/felan', 'linux', 'linked'],
  ] as const)('classifies %s on %s as %s', (path, platform, kind) => {
    expect(detectFelanInstallation(path, platform).kind).toBe(kind);
  });

  it.each([
    ['pnpm', 'pnpm add --global @felan-ai/felan@latest'],
    ['bun', 'bun add --global @felan-ai/felan@latest'],
    ['yarn', 'yarn global add @felan-ai/felan@latest'],
    ['volta', 'volta install @felan-ai/felan@latest'],
    ['npx', 'npx @felan-ai/felan@latest'],
    ['linked', undefined],
    ['unknown', undefined],
  ] as const)('returns the update command for %s', (kind, command) => {
    expect(felanUpdateCommand({ kind, packageDirectory: '/unused' })).toBe(command);
  });

  it('detects a package or scope symlink and reports the resolved checkout', async () => {
    const fixture = await packageFixture('0.12.11');
    const checkout = await temporaryDirectory('felan-checkout-');
    await rm(fixture.packageDirectory, { recursive: true });
    await symlink(checkout, fixture.packageDirectory, 'junction');
    expect(detectFelanInstallation(fixture.packageDirectory)).toEqual({
      kind: 'linked', packageDirectory: await realpath(checkout),
    });

    await rm(join(fixture.globalRoot, '@felan-ai'), { recursive: true });
    await mkdir(join(checkout, 'felan'));
    await symlink(checkout, join(fixture.globalRoot, '@felan-ai'), 'junction');
    expect(detectFelanInstallation(fixture.packageDirectory)).toEqual({
      kind: 'linked', packageDirectory: await realpath(join(checkout, 'felan')),
    });
  });
});

describe('Felan Code update', () => {
  it('reports an already-current global npm installation without installing', async () => {
    const fixture = await packageFixture('0.12.11');
    const calls: string[][] = [];
    const output: string[] = [];

    const exitCode = await runFelanUpdate({
      packageDirectory: fixture.packageDirectory,
      currentVersion: '0.12.11',
      runNpm: npmRunner(fixture.globalRoot, calls, '0.12.11'),
      writeOutput: (line) => output.push(line),
    });

    expect(exitCode).toBe(0);
    expect(calls).toEqual([
      ['root', '--global'],
      ['view', '@felan-ai/felan@latest', 'version'],
    ]);
    expect(output).toEqual(['Felan Code 0.12.11 is already up to date.']);
    expect(prepareDaemonForUpdate).not.toHaveBeenCalled();
  });

  it('installs the exact newer stable version and verifies the package afterward', async () => {
    const fixture = await packageFixture('0.12.11');
    const calls: string[][] = [];
    const workingDirectories: string[] = [];
    const output: string[] = [];

    const exitCode = await runFelanUpdate({
      packageDirectory: fixture.packageDirectory,
      currentVersion: '0.12.11',
      runNpm: npmRunner(fixture.globalRoot, calls, '0.12.12', true, workingDirectories),
      writeOutput: (line) => output.push(line),
    });

    expect(exitCode).toBe(0);
    expect(calls).toEqual([
      ['root', '--global'],
      ['view', '@felan-ai/felan@latest', 'version'],
      ['install', '--global', '@felan-ai/felan@0.12.12'],
    ]);
    expect(workingDirectories).toEqual([
      fixture.packageDirectory,
      fixture.globalRoot,
      fixture.globalRoot,
    ]);
    expect(output).toEqual([
      'Updated Felan Code from 0.12.11 to 0.12.12. Start Felan Code to use the new version.',
    ]);
    expect(prepareDaemonForUpdate).toHaveBeenCalledOnce();
  });

  it('announces when daemon preparation starts stopping the idle daemon', async () => {
    const fixture = await packageFixture('0.12.11');
    const calls: string[][] = [];
    const output: string[] = [];
    vi.mocked(prepareDaemonForUpdate).mockImplementation(async (dependencies) => {
      expect(calls).toEqual([['root', '--global'], ['view', '@felan-ai/felan@latest', 'version']]);
      dependencies?.onStopping?.();
      return { kind: 'stopped', daemonVersion: '0.7.7' };
    });

    await expect(runFelanUpdate({
      packageDirectory: fixture.packageDirectory,
      currentVersion: '0.12.11',
      runNpm: npmRunner(fixture.globalRoot, calls, '0.12.12', true),
      writeOutput: (line) => output.push(line),
    })).resolves.toBe(0);

    expect(output).toEqual([
      'Stopping the idle background daemon...',
      'Updated Felan Code from 0.12.11 to 0.12.12. The background daemon was stopped and starts with 0.12.12 the next time you run Felan Code.',
    ]);
  });

  it.each([
    [{ kind: 'absent' }, 'Start Felan Code to use the new version.'],
    [{ kind: 'stopped', daemonVersion: '0.7.7' },
      'The background daemon was stopped and starts with 0.12.12 the next time you run Felan Code.'],
    [{ kind: 'busy', daemonVersion: '0.7.7', work: 2, runs: 1, attachments: 3 },
      'The background daemon still runs Felan Code 0.12.11 against the new files with 2 active tasks, 1 active run, and 3 attached sessions. '
        + 'Restart it soon with `felan daemon restart` or `/restart` in Felan Code once this work finishes.'],
    [{ kind: 'unavailable', message: 'Daemon status is unavailable. Run felan daemon restart after updating.' },
      'Daemon status is unavailable. Run felan daemon restart after updating.'],
  ] satisfies [DaemonUpdatePreparation, string][])('installs after daemon preparation returns %j', async (daemon, message) => {
    const fixture = await packageFixture('0.12.11', '@felan-ai/felan', 'linux');
    const calls: string[][] = [];
    const output: string[] = [];
    const prepareDaemon = vi.fn(async () => {
      expect(calls).toEqual([['root', '--global'], ['view', '@felan-ai/felan@latest', 'version']]);
      return daemon;
    });

    await expect(runFelanUpdate({
      packageDirectory: fixture.packageDirectory,
      platform: 'linux',
      currentVersion: '0.12.11',
      prepareDaemon,
      runNpm: npmRunner(fixture.globalRoot, calls, '0.12.12', true),
      writeOutput: (line) => output.push(line),
    })).resolves.toBe(0);

    expect(prepareDaemon).toHaveBeenCalledOnce();
    expect(calls.at(-1)).toEqual(['install', '--global', '@felan-ai/felan@0.12.12']);
    expect(output).toEqual([`Updated Felan Code from 0.12.11 to 0.12.12. ${message}`]);
  });

  it.each([
    [2, 1, 3, '2 active tasks, 1 active run, and 3 attached sessions'],
    [0, 0, 1, '0 active tasks, 0 active runs, and 1 attached session'],
    [1, 0, 0, '1 active task, 0 active runs, and 0 attached sessions'],
  ] as const)('refuses to install on Windows when the daemon has %s tasks, %s runs, and %s attachments', async (work, runs, attachments, activity) => {
    const fixture = await packageFixture('0.12.11', '@felan-ai/felan', 'win32');
    const calls: string[][] = [];
    const errors: string[] = [];
    const output: string[] = [];

    await expect(runFelanUpdate({
      packageDirectory: fixture.packageDirectory,
      platform: 'win32',
      currentVersion: '0.12.11',
      prepareDaemon: async () => ({ kind: 'busy', daemonVersion: '0.7.7', work, runs, attachments }),
      runNpm: npmRunner(fixture.globalRoot, calls, '0.12.12', true),
      writeError: (line) => errors.push(line),
      writeOutput: (line) => output.push(line),
    })).resolves.toBe(1);

    expect(calls).toEqual([['root', '--global'], ['view', '@felan-ai/felan@latest', 'version']]);
    expect(output).toEqual([]);
    expect(errors).toEqual([
      `The background daemon has ${activity} holding the installed files. `
        + 'Finish the tasks or exit the sessions, then run `felan daemon stop` '
        + 'or `felan daemon stop --force` to interrupt them, and retry `felan update`.',
    ]);
  });

  it('does not add daemon guidance when installation fails after stopping it', async () => {
    const fixture = await packageFixture('0.12.11');
    const output: string[] = [];
    const errors: string[] = [];

    await expect(runFelanUpdate({
      packageDirectory: fixture.packageDirectory,
      currentVersion: '0.12.11',
      prepareDaemon: async () => ({ kind: 'stopped', daemonVersion: '0.7.7' }),
      runNpm: async (args) => args[0] === 'root'
        ? npmSuccess(fixture.globalRoot)
        : args[0] === 'view' ? npmSuccess('0.12.12') : npmFailure('install failed'),
      writeOutput: (line) => output.push(line),
      writeError: (line) => errors.push(line),
    })).resolves.toBe(1);

    expect(output).toEqual([]);
    expect(errors).toEqual(['Felan Code update failed: install failed']);
  });

  it.each([
    ['0.12.11', '@felan-ai/felan'],
    ['0.12.10', '@felan-ai/felan'],
    ['0.12.11', '@other/package'],
  ])('does not prepare the daemon for an unverified package %s %s', async (version, name) => {
    const fixture = await packageFixture(version, name);
    if (version === '0.12.11' && name === '@felan-ai/felan') {
      await writeFile(join(fixture.packageDirectory, 'package.json'), '{');
    }
    const calls: string[][] = [];

    await expect(runFelanUpdate({
      packageDirectory: fixture.packageDirectory,
      currentVersion: '0.12.11',
      runNpm: npmRunner(fixture.globalRoot, calls, '0.12.12'),
      writeError: vi.fn(),
    })).resolves.toBe(1);

    expect(calls).toEqual([['root', '--global']]);
    expect(prepareDaemonForUpdate).not.toHaveBeenCalled();
  });

  it('does not downgrade when npm latest is older', async () => {
    const fixture = await packageFixture('0.12.11');
    const calls: string[][] = [];
    const output: string[] = [];

    const exitCode = await runFelanUpdate({
      packageDirectory: fixture.packageDirectory,
      currentVersion: '0.12.11',
      runNpm: npmRunner(fixture.globalRoot, calls, '0.12.10'),
      writeOutput: (line) => output.push(line),
    });

    expect(exitCode).toBe(0);
    expect(calls).toHaveLength(2);
    expect(output).toEqual(['Felan Code 0.12.11 is already up to date.']);
    expect(prepareDaemonForUpdate).not.toHaveBeenCalled();
  });

  it('rejects an installation that is not the global npm package before checking the registry', async () => {
    const fixture = await packageFixture('0.12.11');
    const localDirectory = await temporaryDirectory('felan-local-');
    const calls: string[][] = [];
    const errors: string[] = [];

    const exitCode = await runFelanUpdate({
      packageDirectory: localDirectory,
      currentVersion: '0.12.11',
      runNpm: npmRunner(fixture.globalRoot, calls, '0.12.12'),
      writeError: (line) => errors.push(line),
    });

    expect(exitCode).toBe(1);
    expect(calls).toEqual([]);
    expect(errors[0]).toContain(`linked installation at ${await realpath(localDirectory)}`);
    expect(errors[0]).toContain('Update and rebuild that checkout, or unlink it before reinstalling');
    expect(errors[0]).not.toContain('npm install');
    expect(prepareDaemonForUpdate).not.toHaveBeenCalled();
  });

  it.each(['linux', 'win32'] as const)('confirms a different npm prefix and installs into that prefix on %s', async (platform) => {
    const fixture = await packageFixture('0.12.11', '@felan-ai/felan', platform);
    const otherRoot = await temporaryDirectory('other-npm-');
    const calls: string[][] = [];
    const workingDirectories: string[] = [];
    const runNpm = npmRunner(fixture.globalRoot, calls, '0.12.12', true, workingDirectories);
    const output: string[] = [];

    await expect(runFelanUpdate({
      packageDirectory: fixture.packageDirectory,
      platform,
      currentVersion: '0.12.11',
      runNpm: async (args, cwd) => {
        const result = await runNpm(args, cwd);
        return args[0] === 'root' && !args.includes('--prefix') ? npmSuccess(otherRoot) : result;
      },
      writeOutput: (line) => output.push(line),
    })).resolves.toBe(0);

    expect(calls).toEqual([
      ['root', '--global'],
      ['root', '--global', '--prefix', fixture.prefix.replace(/\\/gu, '/')],
      ['view', '@felan-ai/felan@latest', 'version'],
      ['install', '--global', '@felan-ai/felan@0.12.12', '--prefix', fixture.prefix.replace(/\\/gu, '/')],
    ]);
    expect(workingDirectories).toEqual([
      fixture.packageDirectory, fixture.packageDirectory, fixture.globalRoot, fixture.globalRoot,
    ]);
    expect(output).toEqual([
      'Updated Felan Code from 0.12.11 to 0.12.12. Start Felan Code to use the new version.',
    ]);
  });

  it.each([
    ['linux', 'default', 'missing'],
    ['linux', 'fallback', 'missing'],
    ['linux', 'default', 'wrong target'],
    ['linux', 'fallback', 'wrong target'],
    ['win32', 'default', 'missing'],
    ['win32', 'fallback', 'missing'],
    ['win32', 'default', 'wrong target'],
    ['win32', 'fallback', 'wrong target'],
  ] as const)('rejects a %s %s installation with a %s bin link', async (platform, rootKind, binKind) => {
    const fixture = await packageFixture('0.12.11', '@felan-ai/felan', platform);
    const bin = platform === 'win32' ? join(fixture.prefix, 'felan.cmd') : join(fixture.prefix, 'bin', 'felan');
    await rm(bin);
    if (binKind === 'wrong target') {
      if (platform === 'win32') await writeFile(bin, '@"%~dp0%node_modules\\other\\dist\\cli.js" %*');
      else await symlink(join(fixture.packageDirectory, 'package.json'), bin);
    }
    const root = rootKind === 'default' ? fixture.globalRoot : '/other/lib/node_modules';
    const calls: string[][] = [];
    const errors: string[] = [];

    expect(detectFelanInstallation(fixture.packageDirectory, platform).kind).toBe('unknown');
    await expect(runFelanUpdate({
      packageDirectory: fixture.packageDirectory,
      platform,
      currentVersion: '0.12.11',
      runNpm: npmRunner(root, calls, '0.12.12', true),
      writeError: (line) => errors.push(line),
    })).resolves.toBe(1);

    expect(calls).toEqual([['root', '--global']]);
    expect(errors[0]).toContain('Could not verify the running Felan Code package');
    expect(prepareDaemonForUpdate).not.toHaveBeenCalled();
  });

  it('does not confirm a Windows project dependency with npm prefix arithmetic', async () => {
    const packageDirectory = 'C:\\proj\\node_modules\\@felan-ai\\felan';
    const runNpm = vi.fn(async (args: readonly string[]) => npmSuccess(
      args.includes('--prefix') ? 'C:\\proj\\node_modules' : 'C:\\Users\\Alice\\npm\\node_modules',
    ));
    const errors: string[] = [];

    expect(detectFelanInstallation(packageDirectory, 'win32').kind).toBe('unknown');
    await expect(runFelanUpdate({
      packageDirectory,
      platform: 'win32',
      runNpm,
      writeError: (line) => errors.push(line),
    })).resolves.toBe(1);

    expect(runNpm).toHaveBeenCalledExactlyOnceWith(['root', '--global'], packageDirectory);
    expect(errors[0]).toContain('Could not verify the running Felan Code package');
  });

  it('does not suggest a global pnpm update for a project dependency', async () => {
    const prefix = await temporaryDirectory('felan-project-');
    const packageDirectory = join(prefix, 'node_modules', '.pnpm', '@felan-ai+felan@0.12.11', 'node_modules', '@felan-ai', 'felan');
    await mkdir(packageDirectory, { recursive: true });
    const errors: string[] = [];

    expect(felanUpdateCommand(detectFelanInstallation(packageDirectory))).toBeUndefined();
    await expect(runFelanUpdate({
      packageDirectory,
      runNpm: async () => npmSuccess('/other/lib/node_modules'),
      writeError: (line) => errors.push(line),
    })).resolves.toBe(1);

    expect(errors[0]).toContain('Could not verify the running Felan Code package');
    expect(errors[0]).not.toContain('pnpm add --global');
  });

  it.each([false, true])('rejects an unconfirmed prefix when npm confirmation fails: %s', async (fails) => {
    const fixture = await packageFixture('0.12.11');
    const otherRoot = await temporaryDirectory('other-npm-');
    const calls: string[][] = [];
    const errors: string[] = [];

    await expect(runFelanUpdate({
      packageDirectory: fixture.packageDirectory,
      currentVersion: '0.12.11',
      runNpm: async (args) => {
        calls.push([...args]);
        return fails && args.includes('--prefix') ? npmFailure('prefix unavailable') : npmSuccess(otherRoot);
      },
      writeError: (line) => errors.push(line),
    })).resolves.toBe(1);

    expect(calls).toEqual([['root', '--global'], ['root', '--global', '--prefix', fixture.prefix.replace(/\\/gu, '/')]]);
    expect(errors[0]).toContain(fixture.packageDirectory);
    expect(errors[0]).toContain(otherRoot);
    expect(errors[0]).toContain('package manager that installed it');
    expect(errors[0]).not.toContain('npm install');
  });

  it('rejects an unknown layout and names both paths without suggesting another copy', async () => {
    const prefix = await temporaryDirectory('felan-unknown-');
    const packageDirectory = join(prefix, 'custom', 'node_modules', '@felan-ai', 'felan');
    const calls: string[][] = [];
    const errors: string[] = [];
    await mkdir(packageDirectory, { recursive: true });

    await expect(runFelanUpdate({
      packageDirectory,
      platform: 'linux',
      runNpm: npmRunner('/other/lib/node_modules', calls, '0.12.12'),
      writeError: (line) => errors.push(line),
    })).resolves.toBe(1);

    expect(calls).toEqual([['root', '--global']]);
    expect(errors[0]).toContain(packageDirectory);
    expect(errors[0]).toContain('/other/lib/node_modules');
    expect(errors[0]).not.toContain('npm install');
  });

  it('rejects an npm-linked package even when npm reports the same global root', async () => {
    const fixture = await packageFixture('0.12.11');
    const checkout = await temporaryDirectory('felan-checkout-');
    await rm(fixture.packageDirectory, { recursive: true });
    await symlink(checkout, fixture.packageDirectory, 'junction');
    const calls: string[][] = [];
    const errors: string[] = [];

    await expect(runFelanUpdate({
      packageDirectory: fixture.packageDirectory,
      runNpm: npmRunner(fixture.globalRoot, calls, '0.12.12'),
      writeError: (line) => errors.push(line),
    })).resolves.toBe(1);

    expect(calls).toEqual([]);
    expect(errors[0]).toContain(`linked installation at ${await realpath(checkout)}`);
    expect(errors[0]).toContain('unlink');
    expect(errors[0]).not.toContain('npm install');
  });

  it.each([
    ['pnpm/global/5', 'pnpm'],
    ['.bun/install/global', 'bun'],
    ['yarn/global', 'yarn'],
    ['.volta/tools/image/packages/felan', 'volta'],
    ['.npm/_npx/123', 'npx'],
  ] as const)('directs a %s installation to its package manager', async (relativeRoot, kind) => {
    const prefix = await temporaryDirectory('felan-manager-');
    const packageDirectory = join(prefix, relativeRoot, 'node_modules', '@felan-ai', 'felan');
    await mkdir(packageDirectory, { recursive: true });
    const calls: string[][] = [];
    const errors: string[] = [];

    await expect(runFelanUpdate({
      packageDirectory,
      runNpm: npmRunner('/npm/lib/node_modules', calls, '0.12.12'),
      writeError: (line) => errors.push(line),
    })).resolves.toBe(1);

    const installation: FelanInstallation = { kind, packageDirectory };
    expect(calls).toEqual([]);
    expect(errors).toEqual([
      `Felan Code was installed with ${kind}. Update this installation with \`${felanUpdateCommand(installation)}\`.`,
    ]);
    expect(errors[0]).not.toContain('npm install');
  });

  it('rejects prerelease or malformed registry versions', async () => {
    const fixture = await packageFixture('0.12.11');
    const calls: string[][] = [];
    const errors: string[] = [];

    const exitCode = await runFelanUpdate({
      packageDirectory: fixture.packageDirectory,
      currentVersion: '0.12.11',
      runNpm: npmRunner(fixture.globalRoot, calls, '0.13.0-next.1'),
      writeError: (line) => errors.push(line),
    });

    expect(exitCode).toBe(1);
    expect(calls).toHaveLength(2);
    expect(errors).toEqual(['npm returned an invalid stable Felan Code version. Update Felan Code manually.']);
    expect(prepareDaemonForUpdate).not.toHaveBeenCalled();
  });

  it('returns a failure when npm cannot resolve its global root or latest release', async () => {
    const fixture = await packageFixture('0.12.11');
    const errors: string[] = [];

    await expect(runFelanUpdate({
      packageDirectory: fixture.packageDirectory,
      runNpm: async () => npmFailure('permission denied'),
      writeError: (line) => errors.push(line),
    })).resolves.toBe(1);
    expect(errors[0]).toContain('Could not find npm\'s global installation: permission denied');

    errors.length = 0;
    await expect(runFelanUpdate({
      packageDirectory: fixture.packageDirectory,
      currentVersion: '0.12.11',
      runNpm: async (args) => args[0] === 'root'
        ? npmSuccess(fixture.globalRoot)
        : npmFailure('registry unavailable'),
      writeError: (line) => errors.push(line),
    })).resolves.toBe(1);
    expect(errors).toEqual(['Could not check for a newer Felan Code release: registry unavailable']);
    expect(prepareDaemonForUpdate).not.toHaveBeenCalled();
  });

  it('returns a failure when installation or post-install verification fails', async () => {
    const fixture = await packageFixture('0.12.11');
    const errors: string[] = [];

    await expect(runFelanUpdate({
      packageDirectory: fixture.packageDirectory,
      currentVersion: '0.12.11',
      runNpm: async (args) => args[0] === 'root'
        ? npmSuccess(fixture.globalRoot)
        : args[0] === 'view'
          ? npmSuccess('0.12.12')
          : npmFailure('install failed'),
      writeError: (line) => errors.push(line),
    })).resolves.toBe(1);
    expect(errors).toEqual(['Felan Code update failed: install failed']);

    errors.length = 0;
    await expect(runFelanUpdate({
      packageDirectory: fixture.packageDirectory,
      currentVersion: '0.12.11',
      runNpm: async (args) => args[0] === 'root'
        ? npmSuccess(fixture.globalRoot)
        : npmSuccess(args[0] === 'view' ? '0.12.12' : ''),
      writeError: (line) => errors.push(line),
    })).resolves.toBe(1);
    expect(errors).toEqual(['Felan Code update could not verify version 0.12.12. Update Felan Code manually.']);
  });

  it.each([
    ['EBUSY: resource busy or locked', -4082, 'EBUSY: resource busy or locked'],
    ['npm error errno -4082', 1, 'errno -4082'],
  ] as const)('adds recovery guidance when Windows cannot rename the installed package: %s', async (stderr, status, summary) => {
    const fixture = await packageFixture('0.12.11', '@felan-ai/felan', 'win32');
    const errors: string[] = [];

    await expect(runFelanUpdate({
      packageDirectory: fixture.packageDirectory,
      platform: 'win32',
      currentVersion: '0.12.11',
      runNpm: async (args) => args[0] === 'root'
        ? npmSuccess(fixture.globalRoot)
        : args[0] === 'view'
          ? npmSuccess('0.12.12')
          : npmFailure(stderr, status),
      writeError: (line) => errors.push(line),
    })).resolves.toBe(1);

    expect(errors).toEqual([
      `Felan Code update failed: ${summary} `
        + 'A running Felan Code process is using the installed files. Exit all Felan Code sessions, '
        + 'run `felan daemon stop`, then retry from another directory, such as `%TEMP%`.',
    ]);
  });

  it.each(['rename', 'unlink', 'rmdir'])('treats Windows EPERM %s as a file lock', async (syscall) => {
    const fixture = await packageFixture('0.12.11', '@felan-ai/felan', 'win32');
    const errors: string[] = [];
    await expect(runFelanUpdate({
      packageDirectory: fixture.packageDirectory,
      platform: 'win32',
      currentVersion: '0.12.11',
      runNpm: async (args) => args[0] === 'root'
        ? npmSuccess(fixture.globalRoot)
        : args[0] === 'view'
          ? npmSuccess('0.12.12')
          : npmFailure(`npm error code EPERM\nnpm error syscall ${syscall}\nnpm error Error: EPERM: operation not permitted, ${syscall}`),
      writeError: (line) => errors.push(line),
    })).resolves.toBe(1);

    expect(errors[0]).toContain('A running Felan Code process is using the installed files.');
    expect(errors[0]).toContain('run `felan daemon stop`');
    expect(errors[0]).toContain('`%TEMP%`');
    expect(errors[0]).not.toContain('Fix permissions');
  });

  it('uses POSIX recovery guidance without a Windows temporary directory', async () => {
    const fixture = await packageFixture('0.12.11', '@felan-ai/felan', 'linux');
    const errors: string[] = [];
    await expect(runFelanUpdate({
      packageDirectory: fixture.packageDirectory,
      platform: 'linux',
      currentVersion: '0.12.11',
      runNpm: async (args) => args[0] === 'root'
        ? npmSuccess(fixture.globalRoot)
        : args[0] === 'view' ? npmSuccess('0.12.12') : npmFailure('npm error code EBUSY'),
      writeError: (line) => errors.push(line),
    })).resolves.toBe(1);

    expect(errors).toEqual([
      'Felan Code update failed: code EBUSY A running Felan Code process is using the installed files. '
        + 'Exit all Felan Code sessions, run `felan daemon stop`, then retry.',
    ]);
    expect(errors[0]).not.toContain('%TEMP%');
  });

  it.each([
    ['EACCES', 'rename', 'linux'],
    ['EPERM', 'rename', 'linux'],
    ['EPERM', 'mkdir', 'win32'],
  ] as const)('summarizes %s during %s on %s without npm stack noise', async (code, syscall, platform) => {
    const fixture = await packageFixture('0.12.11', '@felan-ai/felan', platform);
    const errors: string[] = [];
    await expect(runFelanUpdate({
      packageDirectory: fixture.packageDirectory,
      platform,
      currentVersion: '0.12.11',
      runNpm: async (args) => args[0] === 'root'
        ? npmSuccess(fixture.globalRoot)
        : args[0] === 'view'
          ? npmSuccess('0.12.12')
          : npmFailure([
            `npm error code ${code}`,
            `npm error syscall ${syscall}`,
            `npm error path ${fixture.packageDirectory}`,
            'npm error dest /some/destination',
            'npm error errno -13',
            `npm error Error: ${code}: permission denied, ${syscall}`,
            'npm error     at async Object.rename (node:internal/fs/promises:784:10)',
            'npm error     at async moveFile (file.js:1:1)',
            'npm error A complete log of this run can be found in: /home/alice/.npm/_logs/log',
          ].join('\n')),
      writeError: (line) => errors.push(line),
    })).resolves.toBe(1);

    expect(errors).toEqual([
      `Felan Code update failed: npm cannot modify ${fixture.packageDirectory} because access was denied. `
        + "Fix permissions of npm's global directory or rerun with the account that installed Felan Code. "
        + 'See https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally.',
    ]);
    expect(errors[0]).not.toMatch(/\bat (?:async|Object\.)/u);
    expect(errors[0]).not.toContain('_logs');
    expect(errors[0]).not.toContain('\n');
  });

  it('uses the global root when a permission failure has no path line', async () => {
    const fixture = await packageFixture('0.12.11');
    const errors: string[] = [];
    await expect(runFelanUpdate({
      packageDirectory: fixture.packageDirectory,
      currentVersion: '0.12.11',
      runNpm: async (args) => args[0] === 'root'
        ? npmSuccess(fixture.globalRoot)
        : args[0] === 'view'
          ? npmSuccess('0.12.12')
          : npmFailure('npm error code EACCES'),
      writeError: (line) => errors.push(line),
    })).resolves.toBe(1);
    expect(errors[0]).toContain(`npm cannot modify ${fixture.globalRoot} because access was denied`);
  });

  it('caps other npm failures and removes stack lines and log-file noise', async () => {
    const fixture = await packageFixture('0.12.11');
    const errors: string[] = [];
    await expect(runFelanUpdate({
      packageDirectory: fixture.packageDirectory,
      currentVersion: '0.12.11',
      runNpm: async (args) => args[0] === 'root'
        ? npmSuccess(fixture.globalRoot)
        : args[0] === 'view'
          ? npmSuccess('0.12.12')
          : npmFailure([
            'npm error code ENOSPC',
            'npm error     at async moveFile (file.js:1:1)',
            'npm error A complete log of this run can be found in: /home/alice/.npm/_logs/log',
            'npm error syscall write',
            'npm error path /installed/package',
            'npm error no space left on device',
            'npm error repeated advice',
          ].join('\n')),
      writeError: (line) => errors.push(line),
    })).resolves.toBe(1);
    expect(errors).toEqual([
      'Felan Code update failed: code ENOSPC; syscall write; path /installed/package; no space left on device',
    ]);
  });
});

interface PackageFixture {
  readonly prefix: string;
  readonly globalRoot: string;
  readonly packageDirectory: string;
}

async function packageFixture(
  version: string,
  name = '@felan-ai/felan',
  platform: NodeJS.Platform = process.platform,
): Promise<PackageFixture> {
  const prefix = await temporaryDirectory('felan-global-');
  const globalRoot = platform === 'win32' ? join(prefix, 'node_modules') : join(prefix, 'lib', 'node_modules');
  const packageDirectory = join(globalRoot, '@felan-ai', 'felan');
  await mkdir(join(packageDirectory, 'dist'), { recursive: true });
  await writeFile(join(packageDirectory, 'package.json'), JSON.stringify({ name, version }));
  await writeFile(join(packageDirectory, 'dist', 'cli.js'), '');
  if (platform === 'win32') {
    await writeFile(join(prefix, 'felan.cmd'), '@"%~dp0%NODE_MODULES\\@FELAN-AI\\FELAN\\dist\\cli.js" %*');
  } else {
    await mkdir(join(prefix, 'bin'));
    await symlink(join(packageDirectory, 'dist', 'cli.js'), join(prefix, 'bin', 'felan'));
  }
  return { prefix, globalRoot, packageDirectory };
}

function npmRunner(
  globalRoot: string,
  calls: string[][],
  latestVersion: string,
  updateManifest = false,
  workingDirectories?: string[],
): (args: readonly string[], cwd: string) => Promise<NpmResult> {
  return async (args, cwd) => {
    calls.push([...args]);
    workingDirectories?.push(cwd);
    if (args[0] === 'root') return npmSuccess(globalRoot);
    if (args[0] === 'view') return npmSuccess(latestVersion);
    if (args[0] === 'install' && updateManifest) {
      await writeFile(join(globalRoot, '@felan-ai', 'felan', 'package.json'), JSON.stringify({
        name: '@felan-ai/felan',
        version: latestVersion,
      }));
    }
    return npmSuccess('');
  };
}

function npmSuccess(stdout: string): NpmResult {
  return { status: 0, stdout, stderr: '' };
}

function npmFailure(stderr: string, status = 1): NpmResult {
  return { status, stdout: '', stderr };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'Content-Type': 'application/json' },
    status: 200,
  });
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}
