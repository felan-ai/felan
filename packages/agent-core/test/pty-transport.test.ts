import { readFileSync, readlinkSync, readdirSync } from 'node:fs';
import { expect, it } from 'vitest';
import { HostAgentRuntime } from '../src/host-agent-runtime.js';

const payload = 'old line\n'.repeat(40_000) + 'last-one\nlast-two 🌍\n';
const expectedBytes = Buffer.byteLength(payload.replaceAll('\n', '\r\n'));
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

it.skipIf(process.platform !== 'linux')('retains complete output and closes slave descriptors across concurrent PTY exits', async () => {
  const before = slaveDescriptors();
  const results: Awaited<ReturnType<typeof runRuntime>>[] = [];
  for (let round = 0; round < 3; round++) {
    const batch = await Promise.allSettled(Array.from({ length: 16 }, () => runRuntime()));
    const errors = batch.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, 'PTY execution or cleanup failed');
    results.push(...batch.flatMap(result => result.status === 'fulfilled' ? [result.value] : []));
  }
  expect(results.filter(result => result.bytes !== expectedBytes || result.exitCode !== 7 || !result.tail.endsWith('last-two 🌍\r\n'))).toEqual([]);
  expect(slaveDescriptors()).toEqual(before);
}, 60_000);

it.skipIf(process.platform !== 'linux')('keeps the slave close-on-exec and releases it after cancellation', async () => {
  const before = slaveDescriptors();
  const runtime = new HostAgentRuntime(process.cwd(), { sessionStorageRoot: process.cwd(), agentStorageRoot: process.cwd() });
  const handle = await runtime.terminals.startShell(`exec ${quote(process.execPath)} -e ${quote('setTimeout(() => {}, 30000)')}`, { shellFlavor: 'posix' });
  try {
    const retained = slaveDescriptors().filter(entry => !before.some(previous => previous.fd === entry.fd));
    expect(retained).toHaveLength(1);
    const flags = readFileSync(`/proc/self/fdinfo/${retained[0]!.fd}`, 'utf8').match(/^flags:\s+([0-7]+)$/mu)?.[1];
    expect(flags).toBeDefined();
    expect(Number.parseInt(flags!, 8) & 0o2000000).not.toBe(0);
  } finally { await handle.dispose(); }
  expect((await handle.read(0)).running).toBe(false);
  expect(slaveDescriptors()).toEqual(before);
}, 5_000);

async function runRuntime() {
  const runtime = new HostAgentRuntime(process.cwd(), { sessionStorageRoot: process.cwd(), agentStorageRoot: process.cwd() });
  const script = "process.stdout.write('old line\\n'.repeat(40000) + 'last-one\\nlast-two 🌍\\n', () => { process.exitCode = 7; });";
  const handle = await runtime.terminals.startShell(`exec ${quote(process.execPath)} -e ${quote(script)}`, { shellFlavor: 'posix' });
  let bytes = 0;
  let offset = 0;
  let tail = Buffer.alloc(0);
  const deadline = Date.now() + 5_000;
  try {
    while (true) {
      const snapshot = await handle.read(offset, { waitMs: 100 });
      offset = snapshot.nextOffset;
      bytes += snapshot.output.length;
      tail = Buffer.concat([tail, snapshot.output]).subarray(-80);
      if (!snapshot.running) return { bytes, exitCode: snapshot.exitCode ?? -1, tail: tail.toString() };
      if (Date.now() > deadline) throw new Error('Runtime PTY did not exit');
    }
  } finally { await handle.dispose(); }
}

function slaveDescriptors(): Array<{ fd: string; path: string }> {
  return readdirSync('/proc/self/fd').flatMap(fd => {
    try {
      const path = readlinkSync(`/proc/self/fd/${fd}`);
      return /^\/dev\/pts\/\d+(?: \(deleted\))?$/u.test(path) ? [{ fd, path }] : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }).sort((left, right) => Number(left.fd) - Number(right.fd));
}
