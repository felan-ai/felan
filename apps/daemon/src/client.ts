export { connectLocalIpc } from './daemon/ipc.js';
export { spawnDetachedDaemon } from './daemon/supervisor.js';
export { assertTargetIdentity, protocolTarget, resolveDaemonTarget } from './daemon/target.js';
export type { DaemonTarget, ResolvedDaemonTarget } from './daemon/target.js';
