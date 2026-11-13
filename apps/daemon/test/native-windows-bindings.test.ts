import type { BigIntStats } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ffi = vi.hoisted(() => ({ size: 32, elevated: 1, elevationSize: 4, success: true, lastError: vi.fn(() => 0), close: vi.fn(), attributes: vi.fn(() => 0), security: vi.fn(), lstat: vi.fn(), load: vi.fn() }));
vi.mock('node:fs', () => ({ lstatSync: (...args: unknown[]) => ffi.lstat(...args) }));
vi.mock('../src/daemon/native-ownership.js', () => ({
  requireOwnershipPlatform: () => 'win32',
  DaemonSecurityError: class extends Error { constructor(readonly code: string, message: string) { super(message); } },
}));
vi.mock('koffi', () => ({ default: {
  load: (...args: unknown[]) => { ffi.load(...args); return { func: (declaration: string) => {
    if (declaration.includes('GetLastError')) return ffi.lastError;
    if (declaration.includes('CloseHandle')) return ffi.close;
    if (declaration.includes('GetFileAttributesW')) return ffi.attributes;
    if (declaration.includes('GetNamedSecurityInfoW')) return ffi.security;
    if (declaration.includes('GetAclInformation')) return (_acl: unknown, information: Buffer) => { information.writeUInt32LE(8, 4); return 1; };
    if (declaration.includes('OpenProcessToken')) return (_process: unknown, _access: number, token: unknown[]) => { token[0] = {}; return 1; };
    if (declaration.includes('GetTokenInformation')) return (_token: unknown, kind: number, buffer: Buffer | null, _size: number, needed: number[]) => {
      needed[0] = kind === 20 ? ffi.elevationSize : ffi.size;
      if (!buffer) return 0;
      if (kind === 20) buffer.writeUInt32LE(ffi.elevated);
      return Number(ffi.success);
    };
    if (declaration.includes('ConvertSidToStringSidW')) return (_sid: unknown, text: unknown[]) => { text[0] = {}; return 1; };
    return () => 0;
  } }; },
  sizeof: () => 8,
  decode: (value: unknown) => Buffer.isBuffer(value) ? {} : 'S-1-5-21-123',
} }));

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  vi.stubGlobal('process', { ...process, platform: 'win32' });
  ffi.size = 32; ffi.elevated = 1; ffi.elevationSize = 4; ffi.success = true;
  ffi.lstat.mockReturnValue({ dev: 1n, ino: 2n });
  ffi.security.mockImplementation((_path: string, _kind: number, _information: number, owner: unknown[], _group: unknown, dacl: unknown[] | null, _sacl: unknown, descriptor: unknown[]) => {
    owner[0] = {}; if (dacl) dacl[0] = {}; descriptor[0] = {}; return 0;
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('Windows token binding contracts', () => {
  it.each(['darwin', 'linux', 'freebsd'])('returns false on %s without loading Windows bindings', async platform => {
    vi.stubGlobal('process', { ...process, platform });
    const native = await import('../src/daemon/native-windows.js');
    expect(native.windowsProcessElevated()).toBe(false); expect(ffi.load).not.toHaveBeenCalled(); expect(ffi.close).not.toHaveBeenCalled();
  });

  it('uses the returned token size without a second-call GetLastError check', async () => {
    const native = await import('../src/daemon/native-windows.js');
    expect(native.windowsAccountPrincipal()).toBe('S-1-5-21-123');
    expect(ffi.lastError).not.toHaveBeenCalled(); expect(ffi.close).toHaveBeenCalledOnce();
  });

  it.each([0, 7, 65_537])('fails closed for an invalid token size of %s', async size => {
    ffi.size = size; const native = await import('../src/daemon/native-windows.js');
    expect(() => native.windowsAccountPrincipal()).toThrow(expect.objectContaining({ code: 'native_failure' }));
    expect(ffi.close).toHaveBeenCalledOnce();
  });

  it.each([0, 1])('reads TokenElevation as a DWORD with value %s', async elevated => {
    ffi.elevated = elevated; const native = await import('../src/daemon/native-windows.js');
    expect(native.windowsProcessElevated()).toBe(Boolean(elevated)); expect(ffi.close).toHaveBeenCalledOnce();
  });

  it.each(['failure', 'size'])('fails closed on an elevation query %s', async failure => {
    if (failure === 'failure') ffi.success = false; else ffi.elevationSize = 0;
    const native = await import('../src/daemon/native-windows.js');
    expect(() => native.windowsProcessElevated()).toThrow(expect.objectContaining({ code: 'native_failure' }));
    expect(ffi.close).toHaveBeenCalledOnce();
  });
});

describe.each(['owned', 'file', 'directory'] as const)('Windows %s path identity checks', kind => {
  let check: () => void;
  beforeEach(async () => {
    const native = await import('../src/daemon/native-windows.js');
    const stat = { dev: 1n, ino: 2n, nlink: 1n, isFile: () => kind !== 'directory', isDirectory: () => kind === 'directory', isSymbolicLink: () => false } as BigIntStats;
    check = () => kind === 'owned' ? native.assertWindowsOwnedFile('state', stat, 'S-1-5-21-123') : native.assertWindowsPrivatePath('state', stat, 'S-1-5-21-123', kind);
  });

  it('checks path identity after native security checks', () => {
    expect(check).not.toThrow(); expect(ffi.lstat).toHaveBeenCalledWith('state', { bigint: true });
    expect(ffi.attributes.mock.invocationCallOrder[0]).toBeLessThan(ffi.lstat.mock.invocationCallOrder[0]!);
    expect(ffi.security.mock.invocationCallOrder[0]).toBeLessThan(ffi.lstat.mock.invocationCallOrder[0]!);
  });

  it.each(['dev', 'ino'] as const)('rejects a replacement path with a different %s', field => {
    ffi.lstat.mockReturnValue({ dev: 1n, ino: 2n, [field]: 3n });
    expect(check).toThrow(expect.objectContaining({ code: 'unsafe_path' }));
  });

  it('fails closed if the checked path disappears', () => {
    const error = Object.assign(new Error('Path removed'), { code: 'ENOENT' });
    ffi.lstat.mockImplementation(() => { throw error; });
    expect(check).toThrow(error);
  });
});
