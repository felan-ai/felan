import { Worker } from 'node:worker_threads';

export function guardAuthenticationParent(parent = process.ppid): Worker {
  if (!Number.isSafeInteger(parent) || parent <= 1) throw new Error('Authentication requires a live daemon parent.');
  const guard = new Worker(`
    const { workerData } = require('node:worker_threads');
    setInterval(() => {
      if (process.ppid !== workerData.parent) process.kill(process.pid, 'SIGKILL');
      if (process.platform === 'win32') {
        // Windows keeps ppid after exit; PID reuse between checks can hide parent death.
        try { process.kill(workerData.parent, 0); }
        catch (error) { if (error.code === 'ESRCH') process.kill(process.pid, 'SIGKILL'); }
      }
    }, 100);
  `, { eval: true, workerData: { parent } });
  guard.unref();
  return guard;
}
