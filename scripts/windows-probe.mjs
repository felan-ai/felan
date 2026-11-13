// Temporary Windows platform probe for the native Windows daemon work. Delete before merge.
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { connect, createServer, Socket } from 'node:net';
import * as os from 'node:os';
import { join } from 'node:path';

const results = {};
const record = (name, fn) => {
  try { results[name] = fn(); } catch (error) { results[name] = { error: error.code ?? error.name, message: error.message }; }
};
const recordAsync = async (name, fn) => {
  try { results[name] = await fn(); } catch (error) { results[name] = { error: error.code ?? error.name, message: error.message }; }
};
const node = (code, options = {}) => execFileSync(process.execPath, ['-e', code], { encoding: 'utf8', ...options }).trim();

const root = fs.mkdtempSync(join(os.tmpdir(), 'fwp-'));
record('environment', () => ({
  platform: process.platform, arch: process.arch, node: process.version,
  getuid: typeof process.getuid, userInfo: os.userInfo(), homedir: os.homedir(), tmpdir: os.tmpdir(),
  realpath: fs.realpathSync(os.tmpdir()), realpathNative: fs.realpathSync.native(os.tmpdir()),
  userInfoWithFakeProfile: JSON.parse(node('console.log(JSON.stringify(require("os").userInfo().homedir))', { env: { ...process.env, USERPROFILE: 'C:\\fake-profile', HOME: 'C:\\fake-home' } })),
  constants: { O_NOFOLLOW: fs.constants.O_NOFOLLOW, O_DIRECTORY: fs.constants.O_DIRECTORY, UV_FS_O_FILEMAP: fs.constants.UV_FS_O_FILEMAP },
}));

record('stat', () => {
  const file = join(root, 'stat.txt'); fs.writeFileSync(file, 'x', { mode: 0o600 });
  const a = fs.lstatSync(file, { bigint: true }); const b = fs.statSync(file, { bigint: true }); const d = fs.lstatSync(root, { bigint: true });
  return { fileMode: a.mode.toString(8), dirMode: d.mode.toString(8), uid: String(a.uid), nlink: String(a.nlink), dev: String(a.dev), ino: String(a.ino), stableIdentity: a.dev === b.dev && a.ino === b.ino };
});

const EXLOCK = 0x10000000;
record('exlock', () => {
  const lock = join(root, 'held.lock');
  const fd = fs.openSync(lock, fs.constants.O_RDWR | fs.constants.O_CREAT | EXLOCK, 0o600);
  const script = (body) => `const fs=require('fs');try{${body};console.log('ok')}catch(e){console.log(e.code||e.message)}`;
  const out = {
    otherExlock: node(script(`fs.openSync(${JSON.stringify(lock)}, fs.constants.O_RDWR | fs.constants.O_CREAT | ${EXLOCK})`)),
    otherPlainRead: node(script(`fs.openSync(${JSON.stringify(lock)}, 'r')`)),
    otherLstat: node(script(`fs.lstatSync(${JSON.stringify(lock)}, { bigint: true })`)),
    otherLutimes: node(script(`fs.lutimesSync(${JSON.stringify(lock)}, new Date(), new Date())`)),
    ownFstat: (() => { fs.fstatSync(fd); return 'ok'; })(),
    ownFutimes: (() => { fs.futimesSync(fd, new Date(), new Date()); return 'ok'; })(),
  };
  fs.closeSync(fd);
  out.afterCloseExlock = node(script(`fs.closeSync(fs.openSync(${JSON.stringify(lock)}, fs.constants.O_RDWR | ${EXLOCK}))`));
  const holder = spawn(process.execPath, ['-e', `require('fs').openSync(${JSON.stringify(lock)}, require('fs').constants.O_RDWR | ${EXLOCK}); setTimeout(() => {}, 60000)`], { stdio: 'ignore' });
  const deadline = Date.now() + 5000; let held = 'ok';
  while (Date.now() < deadline) { held = node(script(`fs.closeSync(fs.openSync(${JSON.stringify(lock)}, fs.constants.O_RDWR | ${EXLOCK}))`)); if (held !== 'ok') break; }
  out.heldByChild = held;
  holder.kill();
  return out;
});

record('directories', () => {
  const dir = join(root, 'dir'); fs.mkdirSync(dir);
  const out = {};
  try { const fd = fs.openSync(dir, 'r'); out.open = 'ok'; try { fs.fsyncSync(fd); out.fsync = 'ok'; } catch (e) { out.fsync = e.code; } fs.closeSync(fd); } catch (e) { out.open = e.code; }
  const target = join(root, 'target.json'); fs.writeFileSync(target, '{}');
  const reader = fs.openSync(target, 'r'); const temp = join(root, 'temp.json'); fs.writeFileSync(temp, '{"a":1}');
  try { fs.renameSync(temp, target); out.renameOverOpenFile = 'ok'; } catch (e) { out.renameOverOpenFile = e.code; }
  fs.closeSync(reader);
  return out;
});

record('acl', () => {
  const run = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8' }).trim(); } catch (e) { return `ERR ${e.message}`; } };
  const local = join(os.userInfo().homedir, 'AppData', 'Local');
  const file = join(root, 'acl.txt'); fs.writeFileSync(file, 'x');
  return { whoami: run('whoami', ['/user', '/fo', 'csv', '/nh']), profile: run('icacls', [os.userInfo().homedir]), appDataLocal: run('icacls', [local]), tmpFile: run('icacls', [file]), driveRoot: run('icacls', ['C:\\']) };
});

record('koffi', () => {
  const koffi = createRequire(new URL('../apps/daemon/package.json', import.meta.url))('koffi');
  const kernel32 = koffi.load('kernel32.dll'); const advapi32 = koffi.load('advapi32.dll');
  const GetCurrentProcess = kernel32.func('void* __stdcall GetCurrentProcess()');
  const CloseHandle = kernel32.func('int __stdcall CloseHandle(void* h)');
  const OpenProcessToken = advapi32.func('int __stdcall OpenProcessToken(void* process, uint32_t access, _Out_ void** token)');
  const GetTokenInformation = advapi32.func('int __stdcall GetTokenInformation(void* token, int cls, _Out_ void* info, uint32_t length, _Out_ uint32_t* returned)');
  const ConvertSidToStringSidW = advapi32.func('int __stdcall ConvertSidToStringSidW(void* sid, _Out_ void** text)');
  const LocalFree = kernel32.func('void* __stdcall LocalFree(void* memory)');
  const token = [null];
  if (!OpenProcessToken(GetCurrentProcess(), 0x0008, token)) return { error: 'OpenProcessToken failed', lastError: koffi.errno() };
  try {
    const length = [0]; GetTokenInformation(token[0], 1, null, 0, length);
    const buffer = Buffer.alloc(length[0]);
    if (!GetTokenInformation(token[0], 1, buffer, buffer.length, length)) return { error: 'GetTokenInformation failed' };
    const sidPointer = koffi.decode(buffer, 'void *');
    const text = [null];
    if (!ConvertSidToStringSidW(sidPointer, text)) return { error: 'ConvertSidToStringSidW failed' };
    const sid = koffi.decode(text[0], 'char16_t', -1); LocalFree(text[0]);
    return { sid, tokenUserBytes: length[0] };
  } finally { CloseHandle(token[0]); }
});

await recordAsync('namedPipe', async () => {
  const name = `\\\\.\\pipe\\felan-probe-${randomBytes(8).toString('hex')}`;
  const server = createServer(socket => socket.pipe(socket));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen({ path: name }, resolve); });
  const second = createServer();
  const duplicate = await new Promise(resolve => { second.once('error', e => resolve(e.code)); second.listen({ path: name }, () => { second.close(); resolve('listened'); }); });
  const echo = await new Promise((resolve, reject) => { const c = connect(name, () => c.write('ping')); c.once('data', d => { c.destroy(); resolve(d.toString()); }); c.once('error', reject); });
  const missing = await new Promise(resolve => { const c = connect(`\\\\.\\pipe\\felan-missing-${randomBytes(8).toString('hex')}`); c.once('connect', () => { c.destroy(); resolve('connected'); }); c.once('error', e => resolve(e.code)); });
  server.close();
  const afterClose = await new Promise(resolve => { const c = connect(name); c.once('connect', () => { c.destroy(); resolve('connected'); }); c.once('error', e => resolve(e.code)); });
  return { duplicateListen: duplicate, echo, missingPipe: missing, afterClose };
});

await recordAsync('launchChannel', async () => {
  const child = spawn(process.execPath, ['-e', `const s=new (require('net').Socket)({fd:3,readable:true,writable:true});s.write('ready');s.once('data',b=>{s.end();process.exit(b[0]===1?0:3)});setTimeout(()=>process.exit(4),5000)`],
    { detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe'] });
  const channel = child.stdio[3];
  const ready = await new Promise((resolve, reject) => { channel.once('data', d => resolve(d.toString())); channel.once('error', reject); child.once('exit', c => reject(new Error(`exit ${c}`))); setTimeout(() => reject(new Error('timeout')), 5000); });
  channel.write(Buffer.from([1]));
  const code = await new Promise(resolve => child.once('exit', resolve));
  return { ready, childExit: code };
});

await recordAsync('windowsHideDefault', async () => {
  const require = createRequire(import.meta.url); const cp = require('node:child_process');
  const original = cp.spawn; let wrapped = 0;
  cp.spawn = function (command, args, options) { wrapped++; return original.call(this, command, args, options); };
  syncBuiltinESMExports();
  const module = join(root, 'uses-spawn.mjs');
  fs.writeFileSync(module, `import { spawn } from 'node:child_process'; export const run = () => new Promise(r => spawn(process.execPath, ['-e', '0']).once('exit', r));`);
  const { run } = await import(`file:///${module.replaceAll('\\', '/')}`);
  await run();
  cp.spawn = original; syncBuiltinESMExports();
  return { wrapperCalledFromEsmNamedImport: wrapped };
});

fs.rmSync(root, { recursive: true, force: true });
console.log(JSON.stringify(results, null, 2));
