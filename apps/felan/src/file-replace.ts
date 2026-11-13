import { renameSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';

interface ReplaceOptions { platform?: NodeJS.Platform; beforeRename?: () => void }
const retryDelay = 50;
const retryLimit = 40;

function retryable(error: unknown, attempt: number, platform: NodeJS.Platform): boolean {
  return platform === 'win32' && attempt < retryLimit && ['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException)?.code ?? '');
}

export async function replaceFile(source: string, target: string, options: ReplaceOptions = {}): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    options.beforeRename?.();
    try { await rename(source, target); return; }
    catch (error) { if (!retryable(error, attempt, options.platform ?? process.platform)) throw error; }
    await wait(retryDelay);
  }
}

export function replaceFileSync(source: string, target: string, options: ReplaceOptions = {}): void {
  for (let attempt = 0; ; attempt++) {
    options.beforeRename?.();
    try { renameSync(source, target); return; }
    catch (error) { if (!retryable(error, attempt, options.platform ?? process.platform)) throw error; }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, retryDelay);
  }
}
