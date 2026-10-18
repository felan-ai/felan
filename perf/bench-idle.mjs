import { execFileSync } from 'node:child_process';
import { ownedProcesses } from './isolation.mjs';
import { startProvider, stopChild, connect, createSession, closeClient } from './setup-session.mjs';
import { sleep } from './lib.mjs';

function cpuTime(pid) {
  const text = execFileSync('ps', ['-o', 'time=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  const parts = text.split(':').map(Number);
  if (parts.some(Number.isNaN)) throw new Error(`Unsupported ps CPU time: ${text}`);
  return parts.reduce((seconds, part) => seconds * 60 + part, 0);
}
export async function run(ctx) {
  const fake = await startProvider(ctx);
  let client;
  try {
    client = await connect(fake.port);
    const session = await createSession(client);
    await client.detach(session);
    client.close(); client = undefined;
    await sleep(ctx.quick ? 500 : 3000);
    const process = ownedProcesses(globalThis.process.env.PROBE_RUNTIME).find(p => p.command.includes('/daemon-host.js'));
    if (!process) throw new Error('Isolated daemon PID not found');
    const startCpu = cpuTime(process.pid); const start = performance.now();
    await sleep(ctx.quick ? 2000 : 20000);
    const seconds = (performance.now() - start) / 1000;
    const used = cpuTime(process.pid) - startCpu;
    ctx.value('daemon.idle-cpu', used / seconds * 100, '% of one core', { seconds, cpuSeconds: used });
  } finally { await closeClient(client); await stopChild(fake.provider); }
}
