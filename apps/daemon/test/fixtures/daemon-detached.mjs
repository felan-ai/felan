import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const build = process.env.S103_DAEMON_BUILD ? pathToFileURL(`${process.env.S103_DAEMON_BUILD}/`) : new URL('../../dist/daemon/', import.meta.url);
const { acquireDaemonOwnership } = await import(new URL('ownership.js', build));
const { listenLocalIpc, serveReadiness } = await import(new URL('ipc.js', build));
const { publishDaemonReadiness } = await import(new URL('supervisor.js', build));

const target = JSON.parse(process.argv[2]);
if (target.kind !== 'isolated') throw new Error('Fixture refuses production');
const owner = await acquireDaemonOwnership(target);
const listener = await listenLocalIpc(owner, socket => serveReadiness(owner, '0.0.0-fixture', socket));
try {
  await publishDaemonReadiness(owner, '0.0.0-fixture', 2_000);
  writeFileSync(join(target.directory, 'launch-env.json'), JSON.stringify({ shared: process.env.S103_SHARED_MARKER === 'synthetic-shared-launch' }), { mode: 0o600 });
  const timer = setInterval(async () => {
    if (!existsSync(join(target.directory, 'fixture-stop'))) return;
    clearInterval(timer); listener.close(); await owner.release();
  }, 10);
} catch {
  listener.close(); await owner.release(); process.exitCode = 1;
}
