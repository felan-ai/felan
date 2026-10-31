import { fileURLToPath } from 'node:url';
import { runDaemonProcess, type HostManager } from '@felan-ai/daemon/daemon-bootstrap';
import { daemonTargetAgentDir, loadAgentEnvironment } from './agent-environment.js';
import { FELAN_VERSION } from './version.js';

const manager: HostManager = {
  packageName: '@felan-ai/felan',
  version: FELAN_VERSION,
  resolveFrom: import.meta.url,
  resolveProvider: specifier => import.meta.resolve(specifier),
  packagedDefaultPath: fileURLToPath(new URL('./host.json', import.meta.url)),
};

const agentDir = daemonTargetAgentDir(process.argv[2]);
if (agentDir && !loadAgentEnvironment(agentDir)) {
  process.stderr.write('Felan daemon could not read .env; using the inherited environment.\n');
}

try { await runDaemonProcess(process.argv.slice(2), manager); }
catch {
  process.stderr.write('Felan daemon could not start. Inspect its private runtime diagnostics.\n');
  process.exitCode = 1;
}
