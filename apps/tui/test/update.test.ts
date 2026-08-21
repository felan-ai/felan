import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runFelanUpdate, type NpmResult } from '../src/update.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
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

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}
