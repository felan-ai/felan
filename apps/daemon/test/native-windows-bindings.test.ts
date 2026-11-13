import { beforeEach, describe, expect, it, vi } from 'vitest';

const ffi = vi.hoisted(() => ({ size: 32, elevated: 1, elevationSize: 4, success: true, lastError: vi.fn(() => 0), close: vi.fn() }));
vi.mock('../src/daemon/native-ownership.js', () => ({
  requireOwnershipPlatform: () => 'win32',
  DaemonSecurityError: class extends Error { constructor(readonly code: string, message: string) { super(message); } },
}));
vi.mock('koffi', () => ({ default: {
  load: () => ({ func: (declaration: string) => {
    if (declaration.includes('GetLastError')) return ffi.lastError;
    if (declaration.includes('CloseHandle')) return ffi.close;
    if (declaration.includes('OpenProcessToken')) return (_process: unknown, _access: number, token: unknown[]) => { token[0] = {}; return 1; };
    if (declaration.includes('GetTokenInformation')) return (_token: unknown, kind: number, buffer: Buffer | null, _size: number, needed: number[]) => {
      needed[0] = kind === 20 ? ffi.elevationSize : ffi.size;
      if (!buffer) return 0;
      if (kind === 20) buffer.writeUInt32LE(ffi.elevated);
      return Number(ffi.success);
    };
    if (declaration.includes('ConvertSidToStringSidW')) return (_sid: unknown, text: unknown[]) => { text[0] = {}; return 1; };
    return () => 0;
  } }),
  sizeof: () => 8,
  decode: (value: unknown) => Buffer.isBuffer(value) ? {} : 'S-1-5-21-123',
} }));

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  ffi.size = 32; ffi.elevated = 1; ffi.elevationSize = 4; ffi.success = true;
});

describe('Windows token binding contracts', () => {
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
