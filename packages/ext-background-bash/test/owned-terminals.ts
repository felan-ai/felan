import type { AgentRuntime, AgentRuntimeProcess, AgentRuntimeTerminationSignal } from '@felan-ai/agent-core';

export function withOwnedTerminals(source: AgentRuntime) {
  const processes = new Map<string, AgentRuntimeProcess>();
  const terminals: NonNullable<AgentRuntime['terminals']> = {
    async startShell(command, options) {
      const process = await source.terminals!.startShell(command, options);
      let signal: AgentRuntimeTerminationSignal | undefined;
      const handle: AgentRuntimeProcess = {
        pid: process.pid,
        async read(offset, options) {
          const snapshot = await process.read(offset, options);
          return { ...snapshot, ...(!snapshot.running && signal ? { signal } : {}) };
        },
        write: bytes => process.write(bytes),
        async terminate(value = 'SIGTERM') { signal = value; await process.terminate(value); },
        dispose: () => process.dispose(),
      };
      if (options?.id) processes.set(options.id, handle);
      return handle;
    },
    attach: id => processes.get(id),
  };
  const runtime = new Proxy(source, { get(target, key) {
    if (key === 'terminals') return terminals;
    const value: unknown = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return {
    runtime,
    async shutdown() {
      await Promise.all([...processes.values()].map(async process => {
        if ((await process.read(0)).running) await process.terminate('SIGKILL');
        await process.dispose();
      }));
      processes.clear();
    },
  };
}
