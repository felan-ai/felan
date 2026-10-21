import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  RUNTIME_DEPENDENCIES_SERVICE,
  createExtensionServiceAccess,
  createFelanServiceRegistry,
  createSilentLogger,
  getExtensionConfigDefinition,
  resolveExtensionConfigs,
  type AgentRuntime,
  type FelanExtensionAPI,
} from '@felan-ai/agent-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import extension, {
  CLAUDE_AGENT_SDK_ENTRY_FILE,
  CLAUDE_CODE_CONFIG,
  MANAGED_CLAUDE_AGENT_SDK_VERSION,
  claudeAgentSdk,
  claudeCodeSettingsFromConfig,
  setClaudeAgentSdk,
} from '../src/index.js';
import packageLock from '../src/managed/agent-sdk-package-lock.json' with { type: 'json' };

type Command = Parameters<FelanExtensionAPI['registerCommand']>[1];
type Provider = Parameters<FelanExtensionAPI['registerProvider']>[1];
const directories: string[] = [];
const shutdowns: Array<() => Promise<void>> = [];
const fakeEntrySource = `
export function query() {
  return { async *[Symbol.asyncIterator]() {}, async interrupt() {}, close() {} };
}
export class McpServer {
  server = { setRequestHandler() {} };
}
export const CallToolRequestSchema = {};
export const ListToolsRequestSchema = {};
`;

beforeEach(() => {
  vi.stubEnv('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC);
});

afterEach(async () => {
  for (const shutdown of shutdowns.splice(0)) await shutdown();
  setClaudeAgentSdk(undefined);
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(kind: AgentRuntime['kind'] = 'host', source?: string, config: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'felan-claude-extension-'));
  directories.push(root);
  if (source !== undefined) {
    const sdkRoot = join(root, 'claude-code', `agent-sdk-${MANAGED_CLAUDE_AGENT_SDK_VERSION}`);
    const platformPackage = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
    const versions = {
      ...packageLock.packages[''].dependencies,
      [platformPackage]: MANAGED_CLAUDE_AGENT_SDK_VERSION,
    };
    for (const [name, version] of Object.entries(versions)) {
      const manifest = join(sdkRoot, 'node_modules', name, 'package.json');
      await mkdir(dirname(manifest), { recursive: true });
      await writeFile(manifest, JSON.stringify({ version }));
    }
    await writeFile(join(sdkRoot, 'node_modules', platformPackage, 'claude'), 'fake binary');
    await writeFile(join(sdkRoot, CLAUDE_AGENT_SDK_ENTRY_FILE), source);
  }
  const storage = {
    root,
    readFile: vi.fn(async (path: string) => readFile(join(root, path))),
    listFiles: vi.fn(async (path: string) => (await readdir(join(root, path))).filter((name) => name === 'claude')),
    writeFile: vi.fn(),
    appendFile: vi.fn(),
    mkdir: vi.fn(),
    remove: vi.fn(),
  };
  const logger = { ...createSilentLogger(), warn: vi.fn(), error: vi.fn() };
  const runtime = {
    kind,
    cwd: root,
    logger,
    storage: vi.fn(() => storage),
    exec: vi.fn(),
    shell: vi.fn(),
  } as unknown as AgentRuntime;
  const install = vi.fn(async () => ({ status: 'installed' as const }));
  const registry = createFelanServiceRegistry();
  registry.set(RUNTIME_DEPENDENCIES_SERVICE, { install });
  const commands = new Map<string, Command>();
  const providers = new Map<string, Provider>();
  const handlers = new Map<string, Array<(event: unknown, context: unknown) => unknown>>();
  const notify = vi.fn();
  const pi = {
    runtime,
    agentDir: root,
    config,
    services: createExtensionServiceAccess(registry, extension.serviceRequirements),
    ui: { notify },
    registerCommand: (name: string, command: Command) => commands.set(name, command),
    registerProvider: (name: string, provider: Provider) => providers.set(name, provider),
    on: (name: string, handler: (event: unknown, context: unknown) => unknown) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
  } as unknown as FelanExtensionAPI;
  await extension(pi);
  shutdowns.push(async () => {
    for (const handler of handlers.get('session_shutdown') ?? []) {
      await handler({}, { sessionManager: { getSessionId: () => root }, cwd: root });
    }
  });
  return { runtime, logger, storage, commands, providers, handlers, install, notify };
}

describe('Claude Code configuration', () => {
  it('associates the definition and optional installation service with the extension', () => {
    expect(getExtensionConfigDefinition(extension)).toBe(CLAUDE_CODE_CONFIG);
    expect(extension.serviceRequirements).toEqual({ optional: [RUNTIME_DEPENDENCIES_SERVICE] });
    expect(CLAUDE_CODE_CONFIG).toMatchObject({ id: 'claude-code', title: 'Claude Code' });
  });

  it('resolves all documented defaults and omits the optional executable', () => {
    const resolved = resolveExtensionConfigs([CLAUDE_CODE_CONFIG]).get('claude-code')!;
    const defaults = {
      plan: 'pro',
      longContextExtraUsage: false,
      forceTwoHundredK: [],
      strictMcpConfig: true,
      autoMemoryEnabled: false,
      inheritAnthropicEnvironment: false,
    };
    expect(resolved).toEqual(defaults);
    expect(claudeCodeSettingsFromConfig(resolved)).toEqual(defaults);
    expect(claudeCodeSettingsFromConfig({})).toEqual(defaults);
  });

  it('maps validated settings without sharing the model array', () => {
    const values = {
      plan: 'max',
      longContextExtraUsage: true,
      forceTwoHundredK: ['claude-opus-4-6'],
      strictMcpConfig: false,
      autoMemoryEnabled: true,
      pathToClaudeCodeExecutable: '/opt/claude/bin/claude',
      inheritAnthropicEnvironment: true,
    };
    const settings = claudeCodeSettingsFromConfig(values);
    expect(settings).toEqual(values);
    expect(settings.forceTwoHundredK).not.toBe(values.forceTwoHundredK);
  });

  it.each([
    ['plan', 'team', 'must be one of: pro, max'],
    ['longContextExtraUsage', 'true', 'must be a boolean'],
    ['forceTwoHundredK', 'claude-opus-4-6', 'must be an array of strings'],
    ['forceTwoHundredK', [42], 'must be an array of strings'],
    ['forceTwoHundredK', null, 'must be an array of strings'],
    ['strictMcpConfig', 1, 'must be a boolean'],
    ['autoMemoryEnabled', null, 'must be a boolean'],
    ['pathToClaudeCodeExecutable', 'bin/claude', 'must be an absolute path'],
    ['pathToClaudeCodeExecutable', '~/bin/claude', 'must be an absolute path'],
    ['pathToClaudeCodeExecutable', '', 'must be an absolute path'],
    ['pathToClaudeCodeExecutable', 1, 'must be a string'],
    ['pathToClaudeCodeExecutable', '/bin/claude\0', 'must be an absolute path'],
    ['inheritAnthropicEnvironment', 'false', 'must be a boolean'],
    ['unknown', true, 'contains unknown field'],
  ])('rejects invalid %s: %j', (field, value, message) => {
    expect(() => claudeCodeSettingsFromConfig({ [field]: value })).toThrow(message);
  });
});

describe('Claude Code extension activation', () => {
  it('registers only the command on a non-host runtime', async () => {
    const h = await fixture('docker');
    expect([...h.commands.keys()]).toEqual(['claude-code']);
    expect(h.providers.size).toBe(0);
    expect(h.handlers.size).toBe(0);
    expect(h.runtime.storage).not.toHaveBeenCalled();
    expect(h.logger.warn).not.toHaveBeenCalled();
    expect(h.logger.error).not.toHaveBeenCalled();
    expect(h.install).not.toHaveBeenCalled();
    expect(h.runtime.exec).not.toHaveBeenCalled();
  });

  it('logs a missing SDK without registering a provider or installing anything', async () => {
    const h = await fixture();
    expect(h.commands.has('claude-code')).toBe(true);
    expect(h.providers.size).toBe(0);
    expect(h.logger.warn).toHaveBeenCalledWith(
      { reason: expect.stringContaining('/claude-code install') },
      expect.stringContaining('not registered'),
    );
    expect(h.install).not.toHaveBeenCalled();
    expect(h.runtime.exec).not.toHaveBeenCalled();
    expect(h.storage.writeFile).not.toHaveBeenCalled();
    expect(h.storage.mkdir).not.toHaveBeenCalled();
    expect(h.storage.remove).not.toHaveBeenCalled();
  });

  it('logs a load failure without registering a provider or installing anything', async () => {
    const h = await fixture('host', 'export const notAnSdk = true;');
    expect(h.commands.has('claude-code')).toBe(true);
    expect(h.providers.size).toBe(0);
    expect(h.handlers.size).toBe(0);
    expect(h.logger.error).toHaveBeenCalledWith(
      { error: expect.stringContaining('missing query export') },
      expect.stringContaining('/claude-code install'),
    );
    expect(h.install).not.toHaveBeenCalled();
    expect(h.runtime.exec).not.toHaveBeenCalled();
    expect(() => claudeAgentSdk()).toThrow('Claude Agent SDK is not installed');
  });

  it('loads a temporary SDK entry and registers models with the resolved settings', async () => {
    const h = await fixture('host', fakeEntrySource, {
      plan: 'max',
      longContextExtraUsage: true,
      forceTwoHundredK: ['claude-opus-4-6'],
    });
    const provider = h.providers.get('claude-code')!;
    expect(provider).toMatchObject({ api: 'claude-code', baseUrl: 'claude-code' });
    expect(provider.models.length).toBeGreaterThan(0);
    expect(provider.models.every((model) => !/-20\d{6}$/.test(model.id))).toBe(true);
    expect(provider.models.every((model) => Object.values(model.cost).every((cost) => cost === 0))).toBe(true);
    const opus = provider.models.find((model) => model.id === 'claude-opus-4-6');
    expect(opus && 'contextWindow' in opus ? opus.contextWindow : undefined).toBe(200_000);
    expect(claudeAgentSdk().query).toBeTypeOf('function');
    expect(h.logger.warn).not.toHaveBeenCalled();
    expect(h.logger.error).not.toHaveBeenCalled();
    expect(h.install).not.toHaveBeenCalled();
    expect(h.runtime.exec).not.toHaveBeenCalled();
    await h.commands.get('claude-code')!.handler('status', {} as Parameters<Command['handler']>[1]);
    expect(h.notify).toHaveBeenLastCalledWith({
      text: expect.stringMatching(/Provider: registered\nplan=max\nlongContextExtraUsage=true/),
      level: 'info',
    });
  });
});
