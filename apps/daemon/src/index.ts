export { SESSION_RUNTIME_SERVICE } from './daemon/session-runtime.js';
export type { SessionRuntime, SessionComposition, SessionCompositionRequest, SessionEnvironment } from './daemon/session-runtime.js';
export { DAEMON_VERSION } from './version.js';

if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  try { await (await import('./daemon/main.js')).runDaemonProcess(process.argv.slice(2)); }
  catch { process.stderr.write('Felan daemon could not start. Inspect its private runtime diagnostics.\n'); process.exitCode = 1; }
}
