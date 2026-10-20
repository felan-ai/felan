import { fileURLToPath } from 'node:url';
import { runDaemonProcess, type HostManager } from '@felan-ai/daemon/daemon-bootstrap';
import { FELAN_VERSION } from './version.js';

const manager: HostManager = {
  packageName: '@felan-ai/felan',
  version: FELAN_VERSION,
  resolveFrom: import.meta.url,
  resolveProvider: specifier => import.meta.resolve(specifier),
  packagedDefaultPath: fileURLToPath(new URL('./host.json', import.meta.url)),
};

try { await runDaemonProcess(process.argv.slice(2), manager); }
catch {
  process.stderr.write('Felan daemon could not start. Inspect its private runtime diagnostics.\n');
  process.exitCode = 1;
}
