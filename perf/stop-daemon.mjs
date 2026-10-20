import { built, isolatedRuntime } from './lib.mjs';

const runtime = isolatedRuntime();
let client;
try {
  const { createDaemonClient } = await built('apps/felan/dist/acp/daemon-session.js');
  const { SessionClient } = await built('apps/felan/dist/client/client.js');
  client = await createDaemonClient({ daemonRuntime: runtime,
    createClient: settings => new SessionClient({ ...settings, launch: undefined, reconnectAttempts: 0 }),
  }, 'headless');
  await client.connect();
  await client.control('host.stop', 'force');
} catch {
  process.exitCode = 1;
} finally {
  client?.close();
}
process.exit(process.exitCode || 0);
