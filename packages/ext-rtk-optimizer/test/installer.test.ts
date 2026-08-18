import { afterEach, describe, expect, it, vi } from 'vitest';

const cryptoMock = vi.hoisted(() => ({ digest: undefined as string | undefined }));

vi.mock('node:crypto', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:crypto')>();
  return {
    ...original,
    createHash: (...args: Parameters<typeof original.createHash>) => {
      if (!cryptoMock.digest) return original.createHash(...args);
      return {
        update: () => ({ digest: () => cryptoMock.digest }),
      };
    },
  };
});

import {
  installManagedRtk,
  managedRtkDirectory,
  managedRtkExecutable,
  MANAGED_RTK_VERSION,
} from '../src/installer.js';
import { MemoryRuntime, result } from './test-runtime.js';

const REVIEWED_INSTALLER_DIGEST = 'd6eb73a772903e13ff34ee1be8a8b24e896ba9a978f20d2279a08b4083ea6f77';

afterEach(() => {
  cryptoMock.digest = undefined;
});

describe('managed RTK installation', () => {
  it('uses runtime-portable managed executable paths', () => {
    expect(managedRtkDirectory(new MemoryRuntime())).toBe('/agent-storage/rtk-optimizer/bin');
    expect(managedRtkExecutable(new MemoryRuntime())).toBe('/agent-storage/rtk-optimizer/bin/rtk');
    expect(managedRtkExecutable(new MemoryRuntime(undefined, 'C:\\agent-storage'))).toBe(
      'C:\\agent-storage\\rtk-optimizer\\bin\\rtk.exe',
    );
  });

  it('runs the reviewed official installer with a pinned version and agent-storage destination', async () => {
    cryptoMock.digest = REVIEWED_INSTALLER_DIGEST;
    let runtime!: MemoryRuntime;
    runtime = new MemoryRuntime(async (command, args) => {
      if (command === 'curl') {
        const output = args.at(-1)!;
        runtime.files.set(output.replace('/agent-storage/', ''), new TextEncoder().encode('reviewed installer'));
        return result();
      }
      if (command === '/usr/bin/env') return result('installed');
      if (command === managedRtkExecutable(runtime)) return result(`rtk ${MANAGED_RTK_VERSION}\n`);
      return result('', 127, 'not found');
    });
    const statuses: string[] = [];

    const installed = await installManagedRtk(runtime, (status) => statuses.push(status));

    expect(installed).toMatchObject({
      rtkAvailable: true,
      command: '/agent-storage/rtk-optimizer/bin/rtk',
      source: 'managed',
      version: `rtk ${MANAGED_RTK_VERSION}`,
    });
    expect(runtime.execCalls.find((call) => call.command === '/usr/bin/env')?.args).toEqual([
      `RTK_VERSION=v${MANAGED_RTK_VERSION}`,
      'RTK_INSTALL_DIR=/agent-storage/rtk-optimizer/bin',
      '/bin/sh',
      expect.stringMatching(/^\/agent-storage\/rtk-optimizer\/install-.+\.sh$/u),
    ]);
    expect(runtime.execCalls.find((call) => call.command === 'curl')?.args).toContain('65536');
    expect(statuses).toHaveLength(2);
    expect([...runtime.files.keys()].some((path) => path.endsWith('.sh'))).toBe(false);
  });

  it('refuses changed installer content and unsupported Windows runtimes', async () => {
    let runtime!: MemoryRuntime;
    runtime = new MemoryRuntime(async (command, args) => {
      if (command === 'curl') {
        runtime.files.set(args.at(-1)!.replace('/agent-storage/', ''), new TextEncoder().encode('changed'));
        return result();
      }
      return result();
    });

    await expect(installManagedRtk(runtime)).resolves.toMatchObject({
      rtkAvailable: false,
      lastError: expect.stringContaining('did not match the reviewed SHA-256'),
    });
    expect(runtime.execCalls.some((call) => call.command === '/usr/bin/env')).toBe(false);

    await expect(installManagedRtk(new MemoryRuntime(undefined, 'C:\\agent-storage'))).resolves.toMatchObject({
      rtkAvailable: false,
      lastError: expect.stringContaining('Linux and macOS only'),
    });
  });
});
