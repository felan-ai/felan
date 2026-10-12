import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const build = process.env.S103_DAEMON_BUILD ? pathToFileURL(`${process.env.S103_DAEMON_BUILD}/`) : new URL('../../dist/daemon/', import.meta.url);
const { acquireDaemonOwnership } = await import(new URL('ownership.js', build));
const { listenLocalIpc, serveReadiness } = await import(new URL('ipc.js', build));

const target = JSON.parse(process.argv[2]);
if (target.kind !== 'isolated') throw new Error('Fixture refuses production');
let owner;
let listener;
async function stop() {
  listener?.close();
  await owner?.release();
}
try {
  owner = await acquireDaemonOwnership(target);
  listener = await listenLocalIpc(owner, socket => serveReadiness(owner, '0.0.0-fixture', socket));
  process.stdout.write(`${JSON.stringify({ ready: owner.identity })}\n`);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', async command => {
      if (command.trim() === 'stop') { await stop(); process.exit(0); }
      if (command.trim() === 'check') {
        try { owner.assertCurrent(); process.stdout.write('current\n'); }
        catch (error) { process.stdout.write(`${error.code}\n`); }
      }
      if (command.trim() === 'spawn-descendant') {
        spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'], { stdio: 'ignore' }).unref();
        process.stdout.write('spawned\n');
      }
    });
} catch (error) {
  await stop();
  process.stdout.write(`${JSON.stringify({ error: error.code ?? 'fixture_failure' })}\n`);
  process.exitCode = 1;
}
