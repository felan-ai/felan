import type { DaemonTarget } from './target.js';
import { resolveDaemonTarget } from './target.js';
import { startDaemonService } from './service.js';
import { publishDaemonReadiness } from './supervisor.js';
import { DAEMON_VERSION } from '../version.js';
import { DaemonIdentitySchema, parseSchema } from '@felan-ai/session-protocol';

export async function runDaemonProcess(args: readonly string[]): Promise<void> {
  if (args.length < 1 || args.length > 3 || args[0]!.length > 65_536
    || args.length === 2 && args[1] !== '--foreground'
    || args.length === 3 && (args[1] !== '--replace' || args[2]!.length > 65_536)) throw new Error('Invalid daemon launch arguments.');
  const target = parseTarget(args[0]!);
  const replacing = args[1] === '--replace' ? parseSchema(DaemonIdentitySchema, JSON.parse(args[2]!)) : undefined;
  const service = await startDaemonService(target, replacing ? { replacing } : {});
  let failed = false;
  const stop = () => { void service.requestStop().then(response => {
    if (response.outcome !== 'accepted') throw new Error('Shutdown was not accepted.');
  }).catch(() => { failed = true; process.stderr.write('Daemon shutdown is blocked. Inspect status and use explicit force only when appropriate.\n'); }); };
  const fail = () => { failed = true; stop(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop); process.on('uncaughtException', fail); process.on('unhandledRejection', fail);
  try {
    if (args[1] === '--foreground') process.stdout.write(`Felan daemon ${DAEMON_VERSION}: ${service.lifecycle.state}\n`);
    else {
      try { await publishDaemonReadiness(service.owner, DAEMON_VERSION, 10_000, service.lifecycle.state === 'blocked' ? 'blocked' : 'ready'); }
      catch { failed = true; stop(); }
    }
    await service.stopped;
  } finally {
    process.off('SIGINT', stop); process.off('SIGTERM', stop); process.off('uncaughtException', fail); process.off('unhandledRejection', fail);
    if (failed) process.exitCode = 1;
  }
}

function parseTarget(text: string): DaemonTarget {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid daemon target.');
  const kind = Reflect.get(value, 'kind');
  const keys = kind === 'production' ? ['kind', 'agentDir', 'storeRoots'] : kind === 'isolated' ? ['kind', 'directory', 'namespaceId', 'storeRoots'] : [];
  if (!keys.length || Object.keys(value).some(key => !keys.includes(key))) throw new Error('Invalid daemon target fields.');
  const target = value as DaemonTarget;
  resolveDaemonTarget(target); return target;
}
