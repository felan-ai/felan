import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkForFelanUpdate,
  runFelanUpdate,
  type NpmResult,
} from '../src/update.js';

const temporaryDirectories: string[] = [];
const previousFelanSkipVersionCheck = process.env.FELAN_SKIP_VERSION_CHECK;
const previousPiOffline = process.env.PI_OFFLINE;

beforeEach(() => {
  delete process.env.FELAN_SKIP_VERSION_CHECK;
  delete process.env.PI_OFFLINE;
});

afterEach(async () => {
  if (previousFelanSkipVersionCheck === undefined) delete process.env.FELAN_SKIP_VERSION_CHECK;
  else process.env.FELAN_SKIP_VERSION_CHECK = previousFelanSkipVersionCheck;
  if (previousPiOffline === undefined) delete process.env.PI_OFFLINE;
  else process.env.PI_OFFLINE = previousPiOffline;
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('Felan update availability check', () => {
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
    await expect(checkForFelanUpdate({
      currentVersion: '0.13.0',
      timeoutMs: 5,
      fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) throw new Error('missing abort signal');
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    })).resolves.toBeUndefined();
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

describe('Felan update', () => {
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
    expect(output).toEqual(['Felan 0.12.11 is already up to date.']);
  });

  it('installs the exact newer stable version and verifies the package afterward', async () => {
    const fixture = await packageFixture('0.12.11');
    const calls: string[][] = [];
    const output: string[] = [];

    const exitCode = await runFelanUpdate({
      packageDirectory: fixture.packageDirectory,
      currentVersion: '0.12.11',
      runNpm: npmRunner(fixture.globalRoot, calls, '0.12.12', true),
      writeOutput: (line) => output.push(line),
    });

    expect(exitCode).toBe(0);
    expect(calls).toEqual([
      ['root', '--global'],
      ['view', '@felan-ai/felan@latest', 'version'],
      ['install', '--global', '@felan-ai/felan@0.12.12'],
    ]);
    expect(output).toEqual([
      'Updated Felan from 0.12.11 to 0.12.12. Restart Felan to use the new version.',
    ]);
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
    expect(output).toEqual(['Felan 0.12.11 is already up to date.']);
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
    expect(calls).toEqual([['root', '--global']]);
    expect(errors[0]).toContain('only supports a verified global npm installation');
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
    expect(errors).toEqual(['npm returned an invalid stable Felan version. Update Felan manually.']);
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
    expect(errors).toEqual(['Could not check for a newer Felan release: registry unavailable']);
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
    expect(errors).toEqual(['Felan update failed: install failed']);

    errors.length = 0;
    await expect(runFelanUpdate({
      packageDirectory: fixture.packageDirectory,
      currentVersion: '0.12.11',
      runNpm: async (args) => args[0] === 'root'
        ? npmSuccess(fixture.globalRoot)
        : npmSuccess(args[0] === 'view' ? '0.12.12' : ''),
      writeError: (line) => errors.push(line),
    })).resolves.toBe(1);
    expect(errors).toEqual(['Felan update could not verify version 0.12.12. Update Felan manually.']);
  });
});

interface PackageFixture {
  readonly globalRoot: string;
  readonly packageDirectory: string;
}

async function packageFixture(version: string, name = '@felan-ai/felan'): Promise<PackageFixture> {
  const globalRoot = await temporaryDirectory('felan-global-');
  const packageDirectory = join(globalRoot, '@felan-ai', 'felan');
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(join(packageDirectory, 'package.json'), JSON.stringify({ name, version }));
  return { globalRoot, packageDirectory };
}

function npmRunner(
  globalRoot: string,
  calls: string[][],
  latestVersion: string,
  updateManifest = false,
): (args: readonly string[], cwd: string) => Promise<NpmResult> {
  return async (args) => {
    calls.push([...args]);
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

function npmFailure(stderr: string): NpmResult {
  return { status: 1, stdout: '', stderr };
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
