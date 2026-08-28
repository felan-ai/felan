import { afterEach, describe, expect, it, vi } from 'vitest';

const cryptoMock = vi.hoisted(() => ({ digest: undefined as string | undefined }));
vi.mock('node:crypto', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:crypto')>();
  return {
    ...original,
    createHash: (...args: Parameters<typeof original.createHash>) => cryptoMock.digest
      ? { update: () => ({ digest: () => cryptoMock.digest }) }
      : original.createHash(...args),
  };
});

import {
  CBM_INSTALLER_SHA256,
  installManagedCbm,
  managedCbmDirectory,
  managedCbmExecutable,
  MANAGED_CBM_VERSION,
} from '../src/installer.js';
import { MemoryRuntime, result } from './test-runtime.js';

afterEach(() => { cryptoMock.digest = undefined; });

describe('managed Codebase Memory installation', () => {
  it('verifies the installer and pins both release and destination', async () => {
    cryptoMock.digest = CBM_INSTALLER_SHA256;
    let runtime!: MemoryRuntime;
    runtime = new MemoryRuntime(async (command, args) => {
      if (command === 'curl') {
        const output = args.at(-1)!;
        runtime.files.set(output.replace('/agent-storage/', ''), new TextEncoder().encode('reviewed installer'));
        return result();
      }
      if (command === '/bin/sh') return result('installed');
      if (command === managedCbmExecutable(runtime)) return result(`codebase-memory-mcp ${MANAGED_CBM_VERSION}`);
      return result('', 127);
    });

    await expect(installManagedCbm(runtime)).resolves.toMatchObject({
      available: true,
      source: 'managed',
      version: MANAGED_CBM_VERSION,
    });
    const install = runtime.execCalls.find((call) => call.command === '/bin/sh')!;
    expect(install.args).toEqual([
      expect.stringMatching(/^\/agent-storage\/codebase-memory\/install-.+\.sh$/u),
      '--dir',
      managedCbmDirectory(runtime),
      '--skip-config',
    ]);
    expect(install.options?.env).toEqual({
      CBM_DOWNLOAD_URL: `https://github.com/DeusData/codebase-memory-mcp/releases/download/v${MANAGED_CBM_VERSION}`,
    });
    expect([...runtime.files.keys()].some((path) => path.endsWith('.sh'))).toBe(false);
  });

  it('refuses a changed installer and Windows managed storage', async () => {
    let runtime!: MemoryRuntime;
    runtime = new MemoryRuntime(async (command, args) => {
      if (command === 'curl') {
        runtime.files.set(args.at(-1)!.replace('/agent-storage/', ''), new TextEncoder().encode('changed'));
        return result();
      }
      return result();
    });
    await expect(installManagedCbm(runtime)).resolves.toMatchObject({ available: false, reason: expect.stringContaining('SHA-256') });
    expect(runtime.execCalls.some((call) => call.command === '/bin/sh')).toBe(false);

    await expect(installManagedCbm(new MemoryRuntime(undefined, 'host', '/repo', 'C:\\agent')))
      .resolves.toMatchObject({ available: false, reason: expect.stringContaining('Linux and macOS') });
  });
});
