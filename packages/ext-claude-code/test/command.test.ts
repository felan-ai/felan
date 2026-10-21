import {
  RUNTIME_DEPENDENCIES_SERVICE,
  createExtensionServiceAccess,
  createFelanServiceRegistry,
  type AgentRuntime,
  type FelanExtensionAPI,
  type RuntimeDependenciesService,
} from '@felan-ai/agent-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerClaudeCodeCommand } from '../src/command.js';
import packageLock from '../src/managed/agent-sdk-package-lock.json' with { type: 'json' };
import { MANAGED_CLAUDE_AGENT_SDK_VERSION } from '../src/managed/index.js';
import { CLAUDE_AGENT_SDK_ENTRY_FILE, setClaudeAgentSdk } from '../src/sdk/runtime.js';

type Command = Parameters<FelanExtensionAPI['registerCommand']>[1];
type CommandContext = Parameters<Command['handler']>[1];

afterEach(() => setClaudeAgentSdk(undefined));

function fixture(options: {
  service?: RuntimeDependenciesService;
  available?: boolean;
  registered?: boolean;
  kind?: AgentRuntime['kind'];
} = {}) {
  let available = options.available ?? false;
  const sdkDirectory = `claude-code/agent-sdk-${MANAGED_CLAUDE_AGENT_SDK_VERSION}`;
  const platformPackage = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  const versions = {
    ...packageLock.packages[''].dependencies,
    [platformPackage]: MANAGED_CLAUDE_AGENT_SDK_VERSION,
  };
  const files = new Map(Object.entries(versions).map(([name, version]) => [
    `${sdkDirectory}/node_modules/${name}/package.json`, JSON.stringify({ version }),
  ]));
  files.set(`${sdkDirectory}/${CLAUDE_AGENT_SDK_ENTRY_FILE}`, 'export function query() {}');
  files.set(`${sdkDirectory}/node_modules/${platformPackage}/claude`, 'fake binary');
  const storage = {
    root: '/agent-storage',
    readFile: vi.fn(async (path: string) => {
      const content = files.get(path);
      if (!available || content === undefined) throw new Error('SDK missing');
      return new TextEncoder().encode(content);
    }),
    listFiles: vi.fn(async (path: string) => available && files.has(`${path}/claude`) ? ['claude'] : []),
  };
  const runtime = {
    kind: options.kind ?? 'host',
    storage: () => storage,
    exec: vi.fn(),
  } as unknown as AgentRuntime;
  const registry = createFelanServiceRegistry();
  if (options.service) registry.set(RUNTIME_DEPENDENCIES_SERVICE, options.service);
  const notify = vi.fn();
  let command!: Command;
  registerClaudeCodeCommand({
    runtime,
    services: createExtensionServiceAccess(registry, { optional: [RUNTIME_DEPENDENCIES_SERVICE] }),
    ui: { notify },
    registerCommand: (name: string, registeredCommand: Command) => {
      expect(name).toBe('claude-code');
      command = registeredCommand;
    },
  } as unknown as FelanExtensionAPI, {
    getSettings: () => ({ plan: 'max', longContextExtraUsage: true, forceTwoHundredK: ['claude-opus-4-6'] }),
    isProviderRegistered: () => options.registered ?? false,
  });
  const controller = new AbortController();
  const context = {
    signal: controller.signal,
    get ui() { throw new Error('Installation must use the host service, not native UI'); },
  } as unknown as CommandContext;
  return {
    command,
    notify,
    storage,
    runtime,
    controller,
    enable: () => { available = true; },
    run: (args: string) => command.handler(args, context),
  };
}

describe('/claude-code', () => {
  it.each(['', 'status', ' STATUS '])('shows status for %j without requiring an installation service', async (args) => {
    const h = fixture();
    await h.run(args);
    expect(h.notify).toHaveBeenLastCalledWith({
      text: expect.stringMatching(/Claude Agent SDK: unavailable .*SDK missing.*\nProvider: not registered\nplan=max\nlongContextExtraUsage=true\nforceTwoHundredK=\["claude-opus-4-6"\]/),
      level: 'warning',
    });
    expect(h.runtime.exec).not.toHaveBeenCalled();
  });

  it('shows the installed version and registered provider without installing', async () => {
    const install = vi.fn<RuntimeDependenciesService['install']>();
    const h = fixture({ available: true, registered: true, service: { install } });
    await h.run('status');
    expect(h.notify).toHaveBeenLastCalledWith({
      text: expect.stringContaining(`Claude Agent SDK: available (${MANAGED_CLAUDE_AGENT_SDK_VERSION})\nProvider: registered`),
      level: 'info',
    });
    expect(install).not.toHaveBeenCalled();
  });

  it('reports a non-host runtime without reading storage', async () => {
    const h = fixture({ kind: 'docker' });
    await h.run('status');
    expect(h.notify).toHaveBeenLastCalledWith({ text: expect.stringContaining('requires a host runtime'), level: 'warning' });
    expect(h.storage.readFile).not.toHaveBeenCalled();
  });

  it('explains that installation requires the local Felan host when the service is absent', async () => {
    const h = fixture();
    await h.run('install');
    expect(h.notify).toHaveBeenLastCalledWith({ text: expect.stringContaining('requires the local Felan host'), level: 'warning' });
    expect(h.storage.readFile).not.toHaveBeenCalled();
    expect(h.runtime.exec).not.toHaveBeenCalled();
  });

  it('delegates installation with the command signal and asks for a new session or reload', async () => {
    let h!: ReturnType<typeof fixture>;
    const install = vi.fn<RuntimeDependenciesService['install']>(async () => {
      h.enable();
      return { status: 'installed' };
    });
    h = fixture({ service: { install } });
    expect(install).not.toHaveBeenCalled();
    await h.run('install');
    expect(install).toHaveBeenCalledExactlyOnceWith({ id: 'claude-code' }, { signal: h.controller.signal });
    expect(h.notify).toHaveBeenLastCalledWith({
      text: 'Claude Agent SDK installed successfully. Start a new session or reload to load Claude models.',
      level: 'info',
    });
    await h.run('status');
    expect(h.notify).toHaveBeenLastCalledWith({
      text: expect.stringContaining(`available (${MANAGED_CLAUDE_AGENT_SDK_VERSION})\nProvider: not registered`),
      level: 'info',
    });
    expect(h.runtime.exec).not.toHaveBeenCalled();
  });

  it.each(['cancelled', 'unavailable'] as const)('reports a host %s result', async (status) => {
    const install = vi.fn<RuntimeDependenciesService['install']>(async () => ({ status, message: 'Host did not install the SDK.' }));
    const h = fixture({ service: { install } });
    await h.run('install');
    expect(h.notify).toHaveBeenLastCalledWith({ text: 'Host did not install the SDK.', level: 'warning' });
    expect(h.storage.readFile).not.toHaveBeenCalled();
  });

  it('reports a service failure', async () => {
    const install = vi.fn<RuntimeDependenciesService['install']>().mockRejectedValue(new Error('Host unavailable'));
    const h = fixture({ service: { install } });
    await h.run('install');
    expect(h.notify).toHaveBeenLastCalledWith({ text: 'Claude Code installation failed: Host unavailable', level: 'error' });
  });

  it('reports a cancelled service request', async () => {
    const install = vi.fn<RuntimeDependenciesService['install']>().mockRejectedValue(new DOMException('Cancelled', 'AbortError'));
    const h = fixture({ service: { install } });
    h.controller.abort();
    await h.run('install');
    expect(h.notify).toHaveBeenLastCalledWith({ text: 'Claude Code installation request cancelled.', level: 'warning' });
  });

  it.each(['help', 'status extra', 'unknown'])('shows usage for %j without inspecting or installing', async (args) => {
    const install = vi.fn<RuntimeDependenciesService['install']>();
    const h = fixture({ service: { install } });
    await h.run(args);
    expect(h.notify).toHaveBeenLastCalledWith({ text: 'Usage: /claude-code [status|install]', level: 'warning' });
    expect(h.storage.readFile).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
  });

  it('completes supported arguments only', async () => {
    const h = fixture();
    expect((await h.command.getArgumentCompletions!(''))?.map(({ value }) => value)).toEqual(['status', 'install']);
    expect((await h.command.getArgumentCompletions!(' IN'))?.map(({ value }) => value)).toEqual(['install']);
    expect(await h.command.getArgumentCompletions!('status extra')).toBeNull();
    expect(await h.command.getArgumentCompletions!('unknown')).toBeNull();
  });
});
