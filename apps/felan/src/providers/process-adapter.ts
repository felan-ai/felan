import { basename, dirname, join, resolve } from 'node:path';
import type { DetachedProcessInspection, ProcessAdapter, ProcessRecord } from '@felan-ai/daemon/provider';
import { BackgroundBashManager, type BackgroundBashInfo } from '@felan-ai/ext-background-bash';

export function createLocalProcessAdapter(): ProcessAdapter {
  return {
    storageDirectory: runtime => join(runtime.storage('session').root, 'background-bash'),
    describeJob(_runtime, path, bytes): ProcessRecord | undefined {
      if (basename(path) !== 'info.json') return undefined;
      if (bytes.byteLength > 64 * 1024) throw new Error('Invalid background job record.');
      let info: BackgroundBashInfo;
      try { info = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as BackgroundBashInfo; }
      catch { throw new Error('Invalid background job record.'); }
      if (!info || typeof info.id !== 'string' || !/^bash-\d{14}-[a-f0-9]{6}$/u.test(info.id)
        || typeof info.infoPath !== 'string' || resolve(info.infoPath) !== path
        || typeof info.jobDir !== 'string' || resolve(info.jobDir) !== dirname(path)
        || info.logPath !== join(info.jobDir, 'output.log') || typeof info.runnerPath !== 'string'
        || typeof info.command !== 'string' || !Number.isSafeInteger(info.startedAt)
        || !['running', 'completed', 'failed', 'killed', 'unknown'].includes(info.status)
        || info.processToken !== undefined && typeof info.processToken !== 'string') throw new Error('Invalid background job identity.');
      return {
        id: info.id, kind: info.executionMode === 'pty' ? 'pty' : 'detached', status: info.status,
        command: info.command, startedAt: info.startedAt, outputPath: info.logPath,
        commandIdentity: [info.runnerPath, ...(info.processToken ? [info.processToken] : [])],
        ...(info.processToken ? { startIdentity: info.processToken } : {}),
        ...(typeof info.exitCode === 'number' && Number.isInteger(info.exitCode) ? { exitCode: info.exitCode } : {}),
      };
    },
    async inspectDetached(runtime, id): Promise<DetachedProcessInspection> {
      const job = await new BackgroundBashManager(runtime).get(id);
      return {
        status: job.status.status,
        ...(job.status.pid === undefined && job.meta.pid === undefined ? {} : { pid: job.status.pid ?? job.meta.pid }),
      };
    },
    async stopDetached(runtime, id, signal): Promise<void> {
      await new BackgroundBashManager(runtime).stop(id, signal);
    },
  };
}
