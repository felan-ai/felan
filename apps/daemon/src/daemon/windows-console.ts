import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';

let installed = false;
export function installWindowsConsoleDefaults(): void {
  if (process.platform !== 'win32' || installed) return;
  for (const name of ['spawn', 'execFile', 'exec', 'fork', 'spawnSync', 'execFileSync', 'execSync'] as const) {
    const original = childProcess[name];
    function wrap(fn: (...args: never[]) => unknown) {
      return function (this: unknown, ...args: unknown[]) {
        const optionalArgs = !['exec', 'execSync'].includes(name);
        const index = optionalArgs && (Array.isArray(args[1]) || (args[1] == null && args.length > 2 && typeof args[2] !== 'function')) ? 2 : 1;
        const options = args[index];
        if (typeof options === 'function' && ['exec', 'execFile'].includes(name)) args.splice(index, 0, { windowsHide: true });
        else if (options == null) args[index] = { windowsHide: true };
        else if (typeof options === 'object' && !Array.isArray(options) && Reflect.get(options, 'windowsHide') === undefined) args[index] = { ...options, windowsHide: true };
        return Reflect.apply(fn, this, args);
      };
    }
    const wrapped = wrap(original);
    const descriptors = Object.getOwnPropertyDescriptors(original);
    const custom = Object.getOwnPropertyDescriptor(original, promisify.custom);
    if (custom && typeof custom.value === 'function') Reflect.set(descriptors, promisify.custom, { ...custom, value: wrap(custom.value) });
    Object.defineProperties(wrapped, descriptors);
    Reflect.set(childProcess, name, wrapped);
  }
  syncBuiltinESMExports(); installed = true;
}
