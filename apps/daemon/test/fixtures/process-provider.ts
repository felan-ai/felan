import { randomBytes } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import type { AgentRuntime } from '@felan-ai/agent-core';
import type { ProcessAdapter } from '../../src/daemon/process-adapter.js';

export function fakeProcessAdapter(directory = 'background-bash'): ProcessAdapter {
  return {
    storageDirectory: runtime => join(runtime.storage('session').root, directory),
    describeJob(_runtime, path, bytes) {
      if (basename(path) !== 'info.json') return undefined;
      const info = JSON.parse(new TextDecoder().decode(bytes));
      if (resolve(info.infoPath) !== path || resolve(info.jobDir) !== dirname(path)
        || info.logPath !== join(info.jobDir, 'output.log')) throw new Error('Invalid process identity');
      return { id: info.id, kind: info.executionMode, status: info.status, command: info.command,
        startedAt: info.startedAt, startIdentity: info.processToken, outputPath: info.logPath,
        commandIdentity: [info.runnerPath, info.processToken] };
    },
    async inspectDetached(runtime, id) {
      try {
        const info = JSON.parse(new TextDecoder().decode(await runtime.storage().readFile(join(directory, id, 'info.json')))) as { status: 'running' };
        return { status: info.status };
      } catch { return { status: 'unknown' }; }
    },
    async stopDetached() {},
  };
}

export class FakeBackgroundProcessProvider {
  constructor(private readonly runtime: AgentRuntime, private readonly directory = 'background-bash') {}

  private async record(command: string, executionMode: 'pty' | 'detached') {
    const id = `bash-20260824000000-${randomBytes(3).toString('hex')}`;
    const storage = this.runtime.storage(); const jobDir = join(storage.root, this.directory, id);
    const meta = { id, command, jobDir, infoPath: join(jobDir, 'info.json'), logPath: join(jobDir, 'output.log'),
      runnerPath: join(jobDir, 'runner.sh'), startedAt: Date.now(), status: 'running', executionMode, processToken: randomBytes(16).toString('hex') };
    await storage.mkdir(jobDir, { recursive: true });
    await storage.writeFile(meta.infoPath, new TextEncoder().encode(JSON.stringify(meta)));
    return { meta };
  }

  async startInteractive(command: string) {
    const job = await this.record(command, 'pty');
    if (!this.runtime.terminals) throw new Error('Terminals unavailable');
    await this.runtime.terminals.startShell(command, { id: job.meta.id, cwd: this.runtime.cwd });
    return { job };
  }

  async start(command: string) {
    const job = await this.record(command, 'detached');
    await this.runtime.shell(command);
    return job;
  }
}
