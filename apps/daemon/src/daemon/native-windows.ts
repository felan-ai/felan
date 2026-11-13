import type { BigIntStats } from 'node:fs';
import koffi from 'koffi';
import { DaemonSecurityError, requireOwnershipPlatform } from './native-ownership.js';

const SYSTEM = 'S-1-5-18';
const ADMINISTRATORS = 'S-1-5-32-544';
const TRUSTED_INSTALLER = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464';
const WRITE_RIGHTS = 0x2 | 0x4 | 0x10 | 0x40 | 0x100 | 0x10000 | 0x40000 | 0x80000 | 0x10000000 | 0x40000000;
let api: ReturnType<typeof loadApi> | undefined;
let principal: string | undefined;

function loadApi() {
  if (requireOwnershipPlatform() !== 'win32') throw new DaemonSecurityError('platform_blocked', 'Windows ownership requires Windows.');
  try {
    const kernel = koffi.load('kernel32.dll'); const security = koffi.load('advapi32.dll');
    return {
      currentProcess: kernel.func('void * __stdcall GetCurrentProcess()'),
      closeHandle: kernel.func('int __stdcall CloseHandle(void *handle)'),
      lastError: kernel.func('uint32_t __stdcall GetLastError()'),
      localFree: kernel.func('void * __stdcall LocalFree(void *memory)'),
      attributes: kernel.func('uint32_t __stdcall GetFileAttributesW(const char16_t *path)'),
      openToken: security.func('int __stdcall OpenProcessToken(void *process, uint32_t access, _Out_ void **token)'),
      tokenInformation: security.func('int __stdcall GetTokenInformation(void *token, int kind, void *information, uint32_t size, _Out_ uint32_t *needed)'),
      sidString: security.func('int __stdcall ConvertSidToStringSidW(const void *sid, _Out_ void **text)'),
      namedSecurity: security.func('uint32_t __stdcall GetNamedSecurityInfoW(const char16_t *path, int kind, uint32_t information, _Out_ void **owner, void *group, _Out_ void **dacl, void *sacl, _Out_ void **descriptor)'),
      aclInformation: security.func('int __stdcall GetAclInformation(const void *acl, void *information, uint32_t size, int kind)'),
      ace: security.func('int __stdcall GetAce(const void *acl, uint32_t index, _Out_ void **ace)'),
      stringDescriptor: security.func('int __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(const char16_t *text, uint32_t revision, _Out_ void **descriptor, void *size)'),
      descriptorDacl: security.func('int __stdcall GetSecurityDescriptorDacl(const void *descriptor, _Out_ int *present, _Out_ void **dacl, _Out_ int *defaulted)'),
      setSecurity: security.func('uint32_t __stdcall SetNamedSecurityInfoW(const char16_t *path, int kind, uint32_t information, void *owner, void *group, void *dacl, void *sacl)'),
    };
  } catch { throw new DaemonSecurityError('platform_blocked', 'Native Windows ownership backend unavailable. No fallback is permitted.'); }
}
function native() { return api ??= loadApi(); }
function failure(operation: string, code = 'unsafe_path', error: number = native().lastError()): never {
  throw new DaemonSecurityError(code, `${operation} failed (Windows error ${error}).`);
}
function sidString(sid: unknown): string {
  const n = native(); const text: unknown[] = [null];
  if (!n.sidString(sid, text)) failure('ConvertSidToStringSidW');
  try { return koffi.decode(text[0], 'char16_t', -1) as string; }
  finally { n.localFree(text[0]); }
}

export function windowsAccountPrincipal(): string {
  if (principal !== undefined) return principal;
  const n = native(); const token: unknown[] = [null];
  if (!n.openToken(n.currentProcess(), 0x8, token)) failure('OpenProcessToken', 'native_failure');
  try {
    const needed = [0];
    n.tokenInformation(token[0], 1, null, 0, needed);
    if (needed[0]! < koffi.sizeof('void *') || needed[0]! > 65536) failure('GetTokenInformation', 'native_failure');
    const buffer = Buffer.alloc(needed[0]!);
    if (!n.tokenInformation(token[0], 1, buffer, buffer.length, needed)) failure('GetTokenInformation', 'native_failure');
    return principal = sidString(koffi.decode(buffer, 'void *'));
  } finally { n.closeHandle(token[0]); }
}

export function windowsProcessElevated(): boolean {
  const n = native(); const token: unknown[] = [null];
  if (!n.openToken(n.currentProcess(), 0x8, token)) failure('OpenProcessToken', 'native_failure');
  try {
    const buffer = Buffer.alloc(4); const needed = [0];
    if (!n.tokenInformation(token[0], 20, buffer, buffer.length, needed) || needed[0] !== buffer.length) failure('GetTokenInformation', 'native_failure');
    return buffer.readUInt32LE() !== 0;
  } finally { n.closeHandle(token[0]); }
}

function securityInfo(path: string, withDacl = true): { owner: string; allowed: { sid: string; mask: number }[] | null } {
  const n = native(); const owner: unknown[] = [null]; const dacl: unknown[] = [null]; const descriptor: unknown[] = [null];
  const error: number = n.namedSecurity(path, 1, withDacl ? 0x1 | 0x4 : 0x1, owner, null, withDacl ? dacl : null, null, descriptor);
  if (error !== 0) failure('GetNamedSecurityInfoW', 'unsafe_path', error);
  try {
    const ownerSid = sidString(owner[0]);
    if (!withDacl || !dacl[0]) return { owner: ownerSid, allowed: null };
    const information = Buffer.alloc(12);
    if (!n.aclInformation(dacl[0], information, information.length, 2)) failure('GetAclInformation');
    const count = information.readUInt32LE(); const used = information.readUInt32LE(4);
    if (used < 8 || used > 65535 || count > (used - 8) / 4) throw new DaemonSecurityError('unsafe_path', 'Invalid daemon path DACL.');
    const allowed: { sid: string; mask: number }[] = [];
    for (let index = 0; index < count; index++) {
      const ace: unknown[] = [null];
      if (!n.ace(dacl[0], index, ace)) failure('GetAce');
      const header = Buffer.from(koffi.decode(ace[0], 'uint8_t', 4) as Uint8Array);
      const type = header[0]!; const size = header.readUInt16LE(2);
      if (size < 4 || size > used - 8) throw new DaemonSecurityError('unsafe_path', 'Invalid daemon path ACE.');
      if ((header[1]! & 0x08) !== 0) continue;
      if ([1, 6, 10, 12].includes(type)) continue;
      // Object and callback allow ACEs require policies this adapter does not interpret.
      if (type !== 0 || size < 16) throw new DaemonSecurityError('unsafe_path', 'Unsupported daemon path allow ACE.');
      const bytes = Buffer.from(koffi.decode(ace[0], 'uint8_t', size) as Uint8Array);
      const mask = bytes.readUInt32LE(4);
      if (mask !== 0) allowed.push({ mask, sid: sidString(bytes.subarray(8)) });
    }
    return { owner: ownerSid, allowed };
  } finally { n.localFree(descriptor[0]); }
}

export function assertWindowsPrivatePath(path: string, stat: BigIntStats, owner: string, kind: 'file' | 'directory'): void {
  const attributes: number = native().attributes(path);
  if (attributes === 0xffffffff) failure('GetFileAttributesW');
  const trusted = new Set([owner, SYSTEM, ADMINISTRATORS]);
  const security = securityInfo(path);
  if ((kind === 'directory' ? !stat.isDirectory() : !stat.isFile()) || stat.isSymbolicLink() || (attributes & 0x400) !== 0 || (kind === 'file' && stat.nlink !== 1n)
    || !trusted.has(security.owner) || security.allowed === null || security.allowed.some(ace => !trusted.has(ace.sid))) {
    throw new DaemonSecurityError('unsafe_path', 'Daemon path must be owner-only, non-reparse and owned by the OS account, SYSTEM or Administrators (regular files require one link).');
  }
}

export function assertWindowsOwnedFile(path: string, stat: BigIntStats, owner: string): void {
  const attributes: number = native().attributes(path);
  if (attributes === 0xffffffff) failure('GetFileAttributesW');
  if (!stat.isFile() || stat.isSymbolicLink() || (attributes & 0x400) !== 0 || stat.nlink !== 1n
    || ![owner, SYSTEM, ADMINISTRATORS].includes(securityInfo(path, false).owner)) {
    throw new DaemonSecurityError('unsafe_path', 'Expected a non-reparse regular file with one link owned by the OS account, SYSTEM or Administrators.');
  }
}

export function windowsWritableByOthers(path: string): boolean {
  const security = securityInfo(path);
  const trusted = new Set([windowsAccountPrincipal(), SYSTEM, ADMINISTRATORS, TRUSTED_INSTALLER]);
  return security.allowed === null || security.allowed.some(ace => (ace.mask & WRITE_RIGHTS) !== 0 && !trusted.has(ace.sid));
}

export function protectWindowsPrivateDirectory(path: string, owner: string): void {
  if (!/^S-1-\d+(?:-\d+)+$/.test(owner)) throw new DaemonSecurityError('unsafe_path', 'Invalid account SID.');
  const n = native(); const descriptor: unknown[] = [null];
  // Protect inheritance so a permissive parent cannot grant access to runtime secrets.
  if (!n.stringDescriptor(`D:P(A;OICI;FA;;;${owner})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`, 1, descriptor, null)) failure('ConvertStringSecurityDescriptorToSecurityDescriptorW');
  try {
    const present = [0]; const dacl: unknown[] = [null]; const defaulted = [0];
    if (!n.descriptorDacl(descriptor[0], present, dacl, defaulted) || !present[0] || !dacl[0]) failure('GetSecurityDescriptorDacl');
    const error: number = n.setSecurity(path, 1, 0x80000004, null, null, dacl[0], null);
    if (error !== 0) failure('SetNamedSecurityInfoW', 'unsafe_path', error);
  } finally { n.localFree(descriptor[0]); }
}
