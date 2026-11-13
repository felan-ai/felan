import childProcess, { spawn } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

const names = ['spawn', 'execFile', 'exec', 'fork', 'spawnSync', 'execFileSync', 'execSync'] as const;
const originals = Object.fromEntries(names.map(name => [name, childProcess[name]]));
afterEach(() => { for (const name of names) Reflect.set(childProcess, name, originals[name]); syncBuiltinESMExports(); vi.resetModules(); });
function installAsWindows(install: () => void) {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  try { Object.defineProperty(process, 'platform', { value: 'win32' }); install(); }
  finally { Object.defineProperty(process, 'platform', platform); }
}

describe('daemon child console defaults', () => {
  it.runIf(process.platform !== 'win32')('does not patch child_process on Unix', async () => {
    const { installWindowsConsoleDefaults } = await import('../src/daemon/windows-console.js');
    installWindowsConsoleDefaults();
    for (const name of names) expect(childProcess[name]).toBe(originals[name]);
  });

  it('updates ESM named imports, handles overloads and preserves explicit options when installed for Windows', async () => {
    const calls = new Map<string, unknown[][]>();
    for (const name of names) {
      calls.set(name, []);
      const stub = (...args: unknown[]) => { calls.get(name)!.push(args); return 'result'; };
      if (name === 'exec' || name === 'execFile') Object.defineProperty(stub, promisify.custom, { value: stub });
      Reflect.set(childProcess, name, stub);
    }
    syncBuiltinESMExports();
    const { installWindowsConsoleDefaults } = await import('../src/daemon/windows-console.js');
    installAsWindows(installWindowsConsoleDefaults); const patched = childProcess.spawn; installAsWindows(installWindowsConsoleDefaults); expect(childProcess.spawn).toBe(patched);
    spawn('command', ['argument']); expect(calls.get('spawn')!.at(-1)).toEqual(['command', ['argument'], { windowsHide: true }]);
    for (const name of names) {
      const invoke = (...args: unknown[]) => Reflect.apply(childProcess[name], undefined, args);
      expect(invoke('command')).toBe('result'); expect(calls.get(name)!.at(-1)).toEqual(['command', { windowsHide: true }]);
      const options = { cwd: 'fixture', windowsHide: false }; invoke('command', options);
      expect(calls.get(name)!.at(-1)).toEqual(['command', options]); expect(calls.get(name)!.at(-1)![1]).toBe(options);
      const defaults = { cwd: 'fixture' }; invoke('command', defaults);
      expect(calls.get(name)!.at(-1)).toEqual(['command', { cwd: 'fixture', windowsHide: true }]); expect(defaults).toEqual({ cwd: 'fixture' });
      if (!['exec', 'execSync'].includes(name)) {
        invoke('command', ['arg'], options); expect(calls.get(name)!.at(-1)).toEqual(['command', ['arg'], options]);
        invoke('command', undefined, defaults); expect(calls.get(name)!.at(-1)).toEqual(['command', undefined, { cwd: 'fixture', windowsHide: true }]);
      }
      if (name === 'exec' || name === 'execFile') {
        const callback = () => {}; invoke('command', callback);
        expect(calls.get(name)!.at(-1)).toEqual(['command', { windowsHide: true }, callback]);
        if (name === 'execFile') { invoke('command', ['arg'], callback); expect(calls.get(name)!.at(-1)).toEqual(['command', ['arg'], { windowsHide: true }, callback]); }
        const custom = Reflect.get(childProcess[name], promisify.custom);
        Reflect.apply(custom, undefined, ['command']); expect(calls.get(name)!.at(-1)).toEqual(['command', { windowsHide: true }]);
      } else {
        const invalid = () => {}; invoke('command', invalid); expect(calls.get(name)!.at(-1)).toEqual(['command', invalid]);
      }
    }
  });

  it('preserves the real execFile promisifier and its child property after installation', async () => {
    const { installWindowsConsoleDefaults } = await import('../src/daemon/windows-console.js'); installAsWindows(installWindowsConsoleDefaults);
    const result = promisify(childProcess.execFile)(process.execPath, ['-e', 'process.stdout.write("fixture")']);
    expect(result.child).toBeDefined(); expect((await result).stdout).toBe('fixture');
  });

  it.runIf(process.platform === 'win32')('launches a real console program through the patched ESM spawn', async () => {
    const { installWindowsConsoleDefaults } = await import('../src/daemon/windows-console.js'); installWindowsConsoleDefaults();
    const child = spawn(process.execPath, ['-e', 'process.stdout.write("fixture")']);
    let output = ''; child.stdout.on('data', bytes => output += bytes);
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    expect(code).toBe(0); expect(output).toBe('fixture');
  });
});
