import { join } from 'node:path';
import { initializeLocalDaemonProcess } from './process-bootstrap.js';
import { ModelRuntime } from '@felan-ai/agent-core';
import { installPiAsyncFileLockGuard } from './pi-lock.js';

export async function createLocalModelRuntime(agentDir: string, signal?: AbortSignal, initializeProcess = initializeLocalDaemonProcess): Promise<ModelRuntime> {
  await initializeProcess(agentDir);
  installPiAsyncFileLockGuard();
  return ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: join(agentDir, 'models.json'),
    ...(signal === undefined ? {} : { signal }) });
}
