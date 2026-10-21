import {
  createSilentLogger,
  type AgentRuntime,
  type AgentRuntimeExecOptions,
  type AgentRuntimeStorage,
  type ExecResult,
  type RuntimeFiles,
} from '@felan-ai/agent-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import packageLock from '../src/managed/agent-sdk-package-lock.json' with { type: 'json' };
import {
  MANAGED_CLAUDE_AGENT_SDK_VERSION,
  inspectClaudeCodeRuntime,
  installManagedClaudeAgentSdk,
  managedClaudeAgentSdkDirectory,
} from '../src/managed/index.js';
import * as linuxLibc from '../src/managed/linux-libc.js';
import { CLAUDE_AGENT_SDK_ENTRY_FILE, CLAUDE_AGENT_SDK_ENTRY_SOURCE } from '../src/sdk/runtime.js';

const DEPENDENCIES = packageLock.packages[''].dependencies;
const DIRECTORY = `claude-code/agent-sdk-${MANAGED_CLAUDE_AGENT_SDK_VERSION}`;
const ENTRY = `${DIRECTORY}/${CLAUDE_AGENT_SDK_ENTRY_FILE}`;

function setPlatform(platform: NodeJS.Platform, arch: string): void {
  vi.stubGlobal('process', { ...process, platform, arch });
}

beforeEach(() => {
  setPlatform('darwin', 'arm64');
  vi.spyOn(linuxLibc, 'detectLinuxLibc').mockReturnValue('glibc');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function result(code = 0, stderr = '', killed = false): ExecResult {
  return { code, stderr, stdout: '', killed };
}

class MemoryRuntime implements AgentRuntime {
  readonly cwd = '/workspace';
  readonly logger = createSilentLogger();
  readonly fileContents = new Map<string, string>();
  readonly directories = new Set<string>();
  readonly modifiedTimes = new Map<string, number>();
  readonly events: string[] = [];
  readonly execCalls: Array<{ command: string; args: readonly string[]; options?: AgentRuntimeExecOptions }> = [];
  readonly storageScopes: string[] = [];
  readonly #storage: AgentRuntimeStorage;
  files: RuntimeFiles | undefined;
  execHandler: (args: readonly string[], directory: string) => Promise<ExecResult> = async (args, directory) => {
    if (args[0] === 'ci') {
      this.seedManifests(directory);
      this.seedPlatform(directory);
    }
    return result();
  };

  constructor(readonly kind: AgentRuntime['kind'] = 'host', readonly root = '/agent-storage') {
    this.#storage = {
      root,
      readFile: async (path) => {
        this.events.push(`read:${path}`);
        const content = this.fileContents.get(path);
        if (content === undefined) throw Object.assign(new Error(`Missing ${path}`), { code: 'ENOENT' });
        return new TextEncoder().encode(content);
      },
      writeFile: async (path, content) => {
        this.events.push(`write:${path}`);
        this.fileContents.set(path, new TextDecoder().decode(content));
      },
      appendFile: async () => { throw new Error('Unexpected append'); },
      listFiles: async (path, options) => {
        this.events.push(`list:${path}`);
        if (path === 'claude-code') {
          expect(options).toEqual({ pattern: 'agent-sdk-*.staging-*', includeDirectories: true, recursive: false });
          return [...new Set([...this.directories, ...this.fileContents.keys()])]
            .filter((entry) => /^claude-code\/agent-sdk-[^/]+\.staging-[^/]+$/u.test(entry))
            .map((entry) => entry.slice('claude-code/'.length));
        }
        expect(options).toEqual({ pattern: 'claude', limit: 1 });
        return this.fileContents.has(`${path}/claude`) ? ['claude'] : [];
      },
      mkdir: async (path, options) => {
        expect(options).toEqual({ recursive: true });
        this.events.push(`mkdir:${path}`);
        this.directories.add(path);
      },
      remove: async (path, options) => {
        expect(options).toEqual({ recursive: true });
        this.events.push(`remove:${path}`);
        let found = this.directories.delete(path);
        for (const file of this.fileContents.keys()) {
          if (file === path || file.startsWith(`${path}/`)) {
            this.fileContents.delete(file);
            found = true;
          }
        }
        if (!found) throw Object.assign(new Error(`Missing ${path}`), { code: 'ENOENT' });
      },
    };
    this.files = {
      move: async (source, target) => {
        expect(source.startsWith(`${root}/`)).toBe(true);
        expect(target).toBe(`${root}/${DIRECTORY}`);
        const directory = source.slice(root.length + 1);
        this.events.push(`move:${directory}:${DIRECTORY}`);
        expect(this.fileContents.get(`${directory}/${CLAUDE_AGENT_SDK_ENTRY_FILE}`)).toBe(CLAUDE_AGENT_SDK_ENTRY_SOURCE);
        expect([...this.fileContents.keys()].some((path) => path.startsWith(`${DIRECTORY}/`))).toBe(false);
        for (const [path, content] of [...this.fileContents]) {
          if (path.startsWith(`${directory}/`)) {
            this.fileContents.set(`${DIRECTORY}${path.slice(directory.length)}`, content);
            this.fileContents.delete(path);
          }
        }
        expect(this.directories.delete(directory)).toBe(true);
        this.directories.add(DIRECTORY);
      },
      inspect: async (path) => {
        expect(path.startsWith(`${root}/`)).toBe(true);
        const relative = path.slice(root.length + 1);
        this.events.push(`inspect:${relative}`);
        return {
          kind: this.directories.has(relative) ? 'directory' : 'file',
          identity: relative,
          size: 0,
          modifiedAt: this.modifiedTimes.get(relative) ?? 0,
        };
      },
      canonicalPath: async () => { throw new Error('Unexpected canonicalPath'); },
      removeEmptyDirectory: async () => { throw new Error('Unexpected removeEmptyDirectory'); },
      touch: async () => { throw new Error('Unexpected touch'); },
      ensurePrivateDirectory: async () => { throw new Error('Unexpected ensurePrivateDirectory'); },
      snapshot: async () => { throw new Error('Unexpected snapshot'); },
      append: async () => { throw new Error('Unexpected append'); },
    };
  }

  seedManifests(directory = DIRECTORY, versions: Partial<Record<keyof typeof DEPENDENCIES, string>> = {}): void {
    for (const [name, version] of Object.entries({ ...DEPENDENCIES, ...versions })) {
      this.fileContents.set(`${directory}/node_modules/${name}/package.json`, JSON.stringify({ name, version }));
    }
  }

  seedPlatform(
    directory = DIRECTORY,
    name = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}${process.platform === 'linux' && linuxLibc.detectLinuxLibc() === 'musl' ? '-musl' : ''}`,
    version = MANAGED_CLAUDE_AGENT_SDK_VERSION,
    binary = true,
  ): void {
    this.fileContents.set(`${directory}/node_modules/${name}/package.json`, JSON.stringify({ name, version }));
    if (binary) this.fileContents.set(`${directory}/node_modules/${name}/claude`, 'binary');
  }

  seedComplete(directory = DIRECTORY): void {
    this.directories.add(directory);
    this.seedManifests(directory);
    this.seedPlatform(directory);
    this.fileContents.set(`${directory}/${CLAUDE_AGENT_SDK_ENTRY_FILE}`, CLAUDE_AGENT_SDK_ENTRY_SOURCE);
  }

  stagingDirectory(): string {
    const cwd = this.execCalls.find((call) => call.args[0] === 'ci')?.options?.cwd;
    expect(cwd).toMatch(new RegExp(`^${this.root}/${DIRECTORY}\\.staging-[a-f0-9-]+$`));
    return cwd!.slice(this.root.length + 1);
  }

  storage(scope = 'session'): AgentRuntimeStorage {
    this.storageScopes.push(scope);
    return this.#storage;
  }

  async exec(command: string, args: readonly string[], options?: AgentRuntimeExecOptions): Promise<ExecResult> {
    this.events.push(`exec:${command} ${args.join(' ')}`);
    this.execCalls.push({ command, args, options });
    return this.execHandler(args, options?.cwd?.slice(this.root.length + 1) ?? '');
  }

  async shell(): Promise<ExecResult> { throw new Error('Unexpected shell'); }
  async readFile(): Promise<Uint8Array> { throw new Error('Unexpected unscoped read'); }
  async writeFile(): Promise<void> { throw new Error('Unexpected unscoped write'); }
  async listFiles(): Promise<string[]> { throw new Error('Unexpected unscoped list'); }
  async mkdir(): Promise<void> { throw new Error('Unexpected unscoped mkdir'); }
  async remove(): Promise<void> { throw new Error('Unexpected unscoped remove'); }
}

describe('reviewed Claude Agent SDK lockfile', () => {
  it('keeps the exported SDK version consistent with the lockfile root pin', () => {
    expect(MANAGED_CLAUDE_AGENT_SDK_VERSION).toBe(DEPENDENCIES['@anthropic-ai/claude-agent-sdk']);
  });

  it('locks every transitive dependency to the npm registry with integrity', () => {
    expect(packageLock.lockfileVersion).toBe(3);
    expect(Object.keys(DEPENDENCIES).sort()).toEqual([
      '@anthropic-ai/claude-agent-sdk', '@anthropic-ai/sdk', '@modelcontextprotocol/sdk', 'zod',
    ]);
    const packages = Object.entries(packageLock.packages).filter(([path]) => path !== '');
    expect(packages).toHaveLength(111);
    for (const [path, entry] of packages) {
      expect(entry, path).toHaveProperty('integrity', expect.stringMatching(/^sha512-/));
      expect(entry, path).toHaveProperty('resolved', expect.stringMatching(/^https:\/\/registry\.npmjs\.org\//));
    }
    for (const [name, version] of Object.entries(DEPENDENCIES)) {
      expect(packageLock.packages[`node_modules/${name}`].version).toBe(version);
    }
  });

  it('locks all eight platform packages listed by the SDK', () => {
    const platforms = packageLock.packages['node_modules/@anthropic-ai/claude-agent-sdk'].optionalDependencies;
    expect(Object.keys(platforms)).toHaveLength(8);
    for (const [name, version] of Object.entries(platforms)) {
      expect(version).toBe(MANAGED_CLAUDE_AGENT_SDK_VERSION);
      expect(packageLock.packages[`node_modules/${name}`].version).toBe(version);
    }
  });
});

describe('Linux libc detection', () => {
  it('detects glibc from the injectable process report reader', () => {
    vi.mocked(linuxLibc.detectLinuxLibc).mockRestore();
    expect(linuxLibc.detectLinuxLibc(() => ({ header: { glibcVersionRuntime: '2.39' } }))).toBe('glibc');
  });

  it.each([undefined, null, {}, { header: {} }, 'report.json'])('detects musl without a glibc report: %j', (report) => {
    vi.mocked(linuxLibc.detectLinuxLibc).mockRestore();
    expect(linuxLibc.detectLinuxLibc(() => report)).toBe('musl');
  });
});

describe('managed Claude Agent SDK inspection', () => {
  it('uses a pinned, runtime-portable directory in agent storage', () => {
    expect(MANAGED_CLAUDE_AGENT_SDK_VERSION).toBe('0.3.293');
    expect(managedClaudeAgentSdkDirectory(new MemoryRuntime())).toBe(`/agent-storage/${DIRECTORY}`);
    expect(managedClaudeAgentSdkDirectory(new MemoryRuntime('host', '/'))).toBe(`/${DIRECTORY}`);
    expect(managedClaudeAgentSdkDirectory(new MemoryRuntime('host', 'C:\\agent-storage')))
      .toBe('C:\\agent-storage\\claude-code\\agent-sdk-0.3.293');
  });

  it.each(['empty', 'entry missing', 'manifest missing'])('reports an incomplete installation: %s', async (state) => {
    const runtime = new MemoryRuntime();
    if (state === 'entry missing') runtime.seedManifests();
    if (state === 'manifest missing') runtime.fileContents.set(ENTRY, CLAUDE_AGENT_SDK_ENTRY_SOURCE);
    const before = [...runtime.fileContents];

    await expect(inspectClaudeCodeRuntime(runtime)).resolves.toMatchObject({
      available: false,
      reason: expect.stringContaining('run /claude-code install'),
    });
    expect([...runtime.fileContents]).toEqual(before);
    expect(runtime.events.every((event) => event.startsWith('read:'))).toBe(true);
    expect(runtime.execCalls).toEqual([]);
  });

  it.each(Object.keys(DEPENDENCIES))('rejects a version mismatch for %s without modifying files', async (name) => {
    const runtime = new MemoryRuntime();
    runtime.seedComplete();
    runtime.fileContents.set(`${DIRECTORY}/node_modules/${name}/package.json`, '{"version":"0.0.0"}');
    const before = [...runtime.fileContents];

    await expect(inspectClaudeCodeRuntime(runtime)).resolves.toMatchObject({
      available: false,
      reason: expect.stringContaining(`${name} reported 0.0.0 instead of`),
    });
    expect([...runtime.fileContents]).toEqual(before);
    expect(runtime.execCalls).toEqual([]);
  });

  it.each(['null', '{}', '{"version":293}', 'not json'])('rejects an invalid SDK manifest: %s', async (manifest) => {
    const runtime = new MemoryRuntime();
    runtime.seedComplete();
    runtime.fileContents.set(`${DIRECTORY}/node_modules/@anthropic-ai/claude-agent-sdk/package.json`, manifest);
    await expect(inspectClaudeCodeRuntime(runtime)).resolves.toMatchObject({ available: false });
  });

  it.each(['missing package', 'missing binary', 'wrong version', 'wrong architecture'])(
    'rejects an unusable platform package: %s', async (state) => {
      const runtime = new MemoryRuntime();
      runtime.seedManifests();
      runtime.fileContents.set(ENTRY, CLAUDE_AGENT_SDK_ENTRY_SOURCE);
      if (state !== 'missing package') {
        runtime.seedPlatform(
          DIRECTORY,
          `@anthropic-ai/claude-agent-sdk-darwin-${state === 'wrong architecture' ? 'x64' : 'arm64'}`,
          state === 'wrong version' ? '0.0.0' : '0.3.293',
          state !== 'missing binary',
        );
      }
      await expect(inspectClaudeCodeRuntime(runtime)).resolves.toMatchObject({
        available: false,
        reason: expect.stringContaining('No usable Claude Agent SDK platform binary for darwin/arm64'),
      });
      expect(runtime.execCalls).toEqual([]);
    },
  );

  it.each([
    ['darwin', 'arm64', ''], ['darwin', 'x64', ''],
    ['linux', 'arm64', ''], ['linux', 'x64', ''],
    ['linux', 'arm64', '-musl'], ['linux', 'x64', '-musl'],
  ] as const)('accepts %s/%s%s with the pinned platform binary', async (platform, arch, suffix) => {
    setPlatform(platform, arch);
    vi.mocked(linuxLibc.detectLinuxLibc).mockReturnValue(suffix ? 'musl' : 'glibc');
    const runtime = new MemoryRuntime();
    runtime.seedManifests();
    runtime.seedPlatform(DIRECTORY, `@anthropic-ai/claude-agent-sdk-${platform}-${arch}${suffix}`);
    runtime.fileContents.set(ENTRY, CLAUDE_AGENT_SDK_ENTRY_SOURCE);

    await expect(inspectClaudeCodeRuntime(runtime)).resolves.toEqual({
      available: true,
      version: '0.3.293',
      entryPath: `/agent-storage/${ENTRY}`,
    });
    expect(runtime.events.every((event) => event.startsWith('read:') || event.startsWith('list:'))).toBe(true);
    expect(runtime.storageScopes.every((scope) => scope === 'agent')).toBe(true);
    expect(runtime.execCalls).toEqual([]);
  });

  it.each(['glibc', 'musl'] as const)('rejects a missing %s binary even if the other Linux variant is valid', async (libc) => {
    setPlatform('linux', 'x64');
    vi.mocked(linuxLibc.detectLinuxLibc).mockReturnValue(libc);
    const runtime = new MemoryRuntime();
    runtime.seedComplete();
    const expected = `@anthropic-ai/claude-agent-sdk-linux-x64${libc === 'musl' ? '-musl' : ''}`;
    runtime.fileContents.delete(`${DIRECTORY}/node_modules/${expected}/claude`);
    runtime.seedPlatform(DIRECTORY, `@anthropic-ai/claude-agent-sdk-linux-x64${libc === 'glibc' ? '-musl' : ''}`);
    await expect(inspectClaudeCodeRuntime(runtime)).resolves.toMatchObject({
      available: false,
      reason: expect.stringContaining(`${expected} is missing its claude binary`),
    });
  });

  it.each(['arm64', 'x64'])('does not detect libc on Darwin %s', async (arch) => {
    setPlatform('darwin', arch);
    const runtime = new MemoryRuntime();
    runtime.seedComplete();
    await expect(inspectClaudeCodeRuntime(runtime)).resolves.toMatchObject({ available: true });
    expect(linuxLibc.detectLinuxLibc).not.toHaveBeenCalled();
  });

  it('does not mistake a completed staging directory for an installation', async () => {
    const runtime = new MemoryRuntime();
    runtime.seedComplete(`${DIRECTORY}.staging-old`);
    await expect(inspectClaudeCodeRuntime(runtime)).resolves.toMatchObject({ available: false });
    expect(runtime.events).toEqual([`read:${ENTRY}`]);
  });
});

describe('managed Claude Agent SDK installation', () => {
  it('runs npm ci with the reviewed lockfile, verifies staging, then moves the completed installation', async () => {
    const runtime = new MemoryRuntime();
    runtime.fileContents.set(`${DIRECTORY}/stale`, 'partial download');
    runtime.fileContents.set(ENTRY, 'old entry');
    const statuses: string[] = [];

    await expect(installManagedClaudeAgentSdk(runtime, (message) => statuses.push(message))).resolves.toEqual({
      available: true,
      version: '0.3.293',
      entryPath: `/agent-storage/${ENTRY}`,
    });
    const staging = runtime.stagingDirectory();
    expect(runtime.execCalls).toEqual([
      { command: 'npm', args: ['--version'], options: { cwd: '/workspace', timeout: 5_000 } },
      {
        command: 'npm',
        args: ['ci', '--ignore-scripts', '--no-audit', '--no-fund'],
        options: { cwd: `/agent-storage/${staging}`, timeout: 900_000 },
      },
    ]);
    expect(JSON.parse(runtime.fileContents.get(`${DIRECTORY}/package.json`)!)).toEqual({
      private: true,
      type: 'module',
      dependencies: DEPENDENCIES,
    });
    expect(JSON.parse(runtime.fileContents.get(`${DIRECTORY}/package-lock.json`)!)).toEqual(packageLock);
    expect(runtime.fileContents.has(`${DIRECTORY}/stale`)).toBe(false);
    expect(runtime.fileContents.get(ENTRY)).toBe(CLAUDE_AGENT_SDK_ENTRY_SOURCE);
    expect(runtime.directories).toEqual(new Set([DIRECTORY]));
    expect(runtime.events).toEqual([
      `read:${ENTRY}`,
      `read:${DIRECTORY}/node_modules/@anthropic-ai/claude-agent-sdk/package.json`,
      'exec:npm --version',
      'list:claude-code',
      `mkdir:${staging}`,
      `write:${staging}/package.json`,
      `write:${staging}/package-lock.json`,
      'exec:npm ci --ignore-scripts --no-audit --no-fund',
      ...Object.keys(DEPENDENCIES).map((name) => `read:${staging}/node_modules/${name}/package.json`),
      `read:${staging}/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/package.json`,
      `list:${staging}/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64`,
      `write:${staging}/${CLAUDE_AGENT_SDK_ENTRY_FILE}`,
      `read:${ENTRY}`,
      `read:${DIRECTORY}/node_modules/@anthropic-ai/claude-agent-sdk/package.json`,
      `remove:${DIRECTORY}`,
      `move:${staging}:${DIRECTORY}`,
    ]);
    expect(runtime.storageScopes.every((scope) => scope === 'agent')).toBe(true);
    expect(statuses).toEqual([
      'Checking npm availability...',
      'Preparing the managed Claude Agent SDK staging directory...',
      'Installing Claude Agent SDK 0.3.293 in Felan agent storage...',
      'Verifying the installed Claude Agent SDK and its dependencies...',
    ]);
  });

  it('returns an available installation without executing npm or writing files, even without move support', async () => {
    const runtime = new MemoryRuntime();
    runtime.seedComplete();
    runtime.seedComplete(`${DIRECTORY}.staging-old`);
    runtime.files = undefined;
    const before = [...runtime.fileContents];
    const statuses: string[] = [];
    await expect(installManagedClaudeAgentSdk(runtime, (message) => statuses.push(message))).resolves.toMatchObject({ available: true });
    expect([...runtime.fileContents]).toEqual(before);
    expect(runtime.execCalls).toEqual([]);
    expect(statuses).toEqual([]);
    expect(runtime.events).not.toContain('list:claude-code');
    expect(runtime.events.every((event) => event.startsWith('read:') || event.startsWith('list:'))).toBe(true);
  });

  it('sweeps expired staging directories across versions before creating staging, but preserves recent and unrelated entries', async () => {
    const runtime = new MemoryRuntime();
    const now = 2_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const expired = ['claude-code/agent-sdk-0.1.0.staging-crashed', `${DIRECTORY}.staging-boundary`];
    const recent = `${DIRECTORY}.staging-recent`;
    const unrelated = ['claude-code/agent-sdk-0.1.0', 'claude-code/other.staging-old'];
    for (const directory of [...expired, recent, ...unrelated]) runtime.seedComplete(directory);
    runtime.modifiedTimes.set(expired[0], now - 900_001);
    runtime.modifiedTimes.set(expired[1], now - 900_000);
    runtime.modifiedTimes.set(recent, now - 899_999);
    const file = `${DIRECTORY}.staging-file`;
    runtime.fileContents.set(file, 'not a directory');

    await expect(installManagedClaudeAgentSdk(runtime)).resolves.toMatchObject({ available: true });
    const creation = runtime.events.indexOf(`mkdir:${runtime.stagingDirectory()}`);
    for (const directory of expired) {
      expect(runtime.directories.has(directory)).toBe(false);
      expect(runtime.events.indexOf(`remove:${directory}`)).toBeLessThan(creation);
      expect([...runtime.fileContents.keys()].some((path) => path.startsWith(`${directory}/`))).toBe(false);
    }
    for (const directory of [recent, ...unrelated]) {
      expect(runtime.directories.has(directory)).toBe(true);
      expect(runtime.events).not.toContain(`remove:${directory}`);
    }
    expect(runtime.fileContents.get(file)).toBe('not a directory');
  });

  it('sweeps every matching staging directory when modification times are unavailable', async () => {
    const runtime = new MemoryRuntime();
    const stale = `${DIRECTORY}.staging-unknown-age`;
    runtime.seedComplete(stale);
    runtime.modifiedTimes.set(stale, Date.now());
    runtime.files!.inspect = undefined;

    await expect(installManagedClaudeAgentSdk(runtime)).resolves.toMatchObject({ available: true });
    expect(runtime.directories.has(stale)).toBe(false);
    expect(runtime.events).toContain(`remove:${stale}`);
  });

  it.each(['list', 'inspect', 'remove'] as const)('continues installing when a stale staging %s operation fails', async (operation) => {
    const runtime = new MemoryRuntime();
    const stale = `${DIRECTORY}.staging-failure`;
    const other = `${DIRECTORY}.staging-other`;
    runtime.seedComplete(stale);
    runtime.seedComplete(other);
    const warning = vi.spyOn(runtime.logger, 'warn');
    if (operation === 'inspect') {
      vi.spyOn(runtime.files!, 'inspect').mockRejectedValueOnce(new Error('permission denied'));
    } else {
      vi.spyOn(runtime.storage('agent'), operation === 'list' ? 'listFiles' : 'remove')
        .mockRejectedValueOnce(new Error('permission denied'));
    }

    await expect(installManagedClaudeAgentSdk(runtime)).resolves.toMatchObject({ available: true });
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('permission denied'));
    expect(runtime.directories.has(stale)).toBe(true);
    expect(runtime.directories.has(other)).toBe(operation === 'list');
  });

  it('ignores missing staging storage and unexpected listing paths', async () => {
    const runtime = new MemoryRuntime();
    const listing = vi.spyOn(runtime.storage('agent'), 'listFiles');
    listing.mockRejectedValueOnce(Object.assign(new Error('not found'), { code: 'ENOENT' }));
    const warning = vi.spyOn(runtime.logger, 'warn');
    await expect(installManagedClaudeAgentSdk(runtime)).resolves.toMatchObject({ available: true });
    expect(warning).not.toHaveBeenCalled();

    const second = new MemoryRuntime();
    vi.spyOn(second.storage('agent'), 'listFiles').mockResolvedValueOnce([
      '../agent-sdk-0.1.0.staging-escape', 'agent-sdk-0.1.0.staging-nested/child', DIRECTORY,
    ]);
    await expect(installManagedClaudeAgentSdk(second)).resolves.toMatchObject({ available: true });
    expect(second.events.filter((event) => event.startsWith('remove:'))).toEqual([`remove:${DIRECTORY}`]);
  });

  it.each([false, true])('preserves an installation promoted during npm ci (cleanup failure: %s)', async (cleanupFails) => {
    const runtime = new MemoryRuntime();
    const install = runtime.execHandler;
    runtime.execHandler = async (args, directory) => {
      const response = await install(args, directory);
      if (args[0] === 'ci') {
        runtime.seedComplete();
        runtime.fileContents.set(`${DIRECTORY}/other-installer`, 'preserved');
      }
      return response;
    };
    if (cleanupFails) vi.spyOn(runtime.storage('agent'), 'remove').mockRejectedValue(new Error('permission denied'));

    await expect(installManagedClaudeAgentSdk(runtime)).resolves.toEqual({
      available: true, version: MANAGED_CLAUDE_AGENT_SDK_VERSION, entryPath: `/agent-storage/${ENTRY}`,
    });
    expect(runtime.fileContents.get(`${DIRECTORY}/other-installer`)).toBe('preserved');
    expect(runtime.events).not.toContain(`remove:${DIRECTORY}`);
    expect(runtime.events.some((event) => event.startsWith('move:'))).toBe(false);
    expect(runtime.directories.has(runtime.stagingDirectory())).toBe(cleanupFails);
  });

  it('installs into a previously missing directory', async () => {
    const runtime = new MemoryRuntime();
    await expect(installManagedClaudeAgentSdk(runtime)).resolves.toMatchObject({ available: true });
    await expect(inspectClaudeCodeRuntime(runtime)).resolves.toMatchObject({ available: true });
  });

  it('accepts a musl-only Linux installation', async () => {
    setPlatform('linux', 'x64');
    vi.mocked(linuxLibc.detectLinuxLibc).mockReturnValue('musl');
    const runtime = new MemoryRuntime();
    runtime.execHandler = async (args, directory) => {
      if (args[0] === 'ci') {
        runtime.seedManifests(directory);
        runtime.seedPlatform(directory, '@anthropic-ai/claude-agent-sdk-linux-x64-musl');
      }
      return result();
    };
    await expect(installManagedClaudeAgentSdk(runtime)).resolves.toMatchObject({ available: true });
  });

  it.each(['glibc', 'musl'] as const)('rejects a Linux install with only the non-host libc binary on %s', async (libc) => {
    setPlatform('linux', 'x64');
    vi.mocked(linuxLibc.detectLinuxLibc).mockReturnValue(libc);
    const runtime = new MemoryRuntime();
    runtime.execHandler = async (args, directory) => {
      if (args[0] === 'ci') {
        runtime.seedManifests(directory);
        runtime.seedPlatform(directory, `@anthropic-ai/claude-agent-sdk-linux-x64${libc === 'glibc' ? '-musl' : ''}`);
      }
      return result();
    };
    await expect(installManagedClaudeAgentSdk(runtime)).resolves.toMatchObject({
      available: false, reason: expect.stringContaining('No usable Claude Agent SDK platform binary'),
    });
    expect(runtime.events).not.toContain(`remove:${DIRECTORY}`);
    expect(runtime.directories.size).toBe(0);
  });

  it.each(['exit code', 'exception', 'timeout'])('preserves the previous state and removes staging on npm failure: %s', async (failure) => {
    const runtime = new MemoryRuntime();
    runtime.fileContents.set(`${DIRECTORY}/existing`, 'preserved');
    const before = [...runtime.fileContents];
    runtime.execHandler = async (args, directory) => {
      if (args[0] === '--version') return result();
      runtime.fileContents.set(`${directory}/partial-download`, 'incomplete');
      if (failure === 'exception') throw new Error('spawn npm ENOENT');
      return failure === 'timeout' ? result(0, '', true) : result(1, 'registry unavailable');
    };

    await expect(installManagedClaudeAgentSdk(runtime)).resolves.toMatchObject({
      available: false,
      reason: expect.stringContaining('npm ci failed'),
    });
    expect([...runtime.fileContents]).toEqual(before);
    expect(runtime.directories.size).toBe(0);
    expect(runtime.events.at(-1)).toBe(`remove:${runtime.stagingDirectory()}`);
    expect(runtime.events).not.toContain(`remove:${DIRECTORY}`);
  });

  it.each(Object.keys(DEPENDENCIES))('preserves the previous state when installed %s has the wrong version', async (name) => {
    const runtime = new MemoryRuntime();
    runtime.fileContents.set(`${DIRECTORY}/existing`, 'preserved');
    const before = [...runtime.fileContents];
    runtime.execHandler = async (args, directory) => {
      if (args[0] === 'ci') {
        runtime.seedManifests(directory);
        runtime.seedPlatform(directory);
        runtime.fileContents.set(`${directory}/node_modules/${name}/package.json`, '{"version":"0.0.0"}');
      }
      return result();
    };

    await expect(installManagedClaudeAgentSdk(runtime)).resolves.toMatchObject({
      available: false,
      reason: expect.stringContaining(`${name} reported 0.0.0 instead of`),
    });
    expect([...runtime.fileContents]).toEqual(before);
    expect(runtime.events).not.toContain(`remove:${DIRECTORY}`);
    expect(runtime.directories.size).toBe(0);
  });

  it.each(['missing', 'wrong version', 'missing binary'])('rejects an installed platform package that is %s', async (state) => {
    const runtime = new MemoryRuntime();
    runtime.fileContents.set(`${DIRECTORY}/existing`, 'preserved');
    const before = [...runtime.fileContents];
    runtime.execHandler = async (args, directory) => {
      if (args[0] === 'ci') {
        runtime.seedManifests(directory);
        if (state !== 'missing') {
          runtime.seedPlatform(directory, undefined, state === 'wrong version' ? '0.0.0' : '0.3.293', state !== 'missing binary');
        }
      }
      return result();
    };
    await expect(installManagedClaudeAgentSdk(runtime)).resolves.toMatchObject({
      available: false,
      reason: expect.stringContaining('No usable Claude Agent SDK platform binary'),
    });
    expect([...runtime.fileContents]).toEqual(before);
    expect(runtime.events).not.toContain(`remove:${DIRECTORY}`);
    expect(runtime.directories.size).toBe(0);
  });

  it('cleans up when npm reports success without producing the manifests', async () => {
    const runtime = new MemoryRuntime();
    runtime.execHandler = async () => result();
    await expect(installManagedClaudeAgentSdk(runtime)).resolves.toMatchObject({ available: false });
    expect(runtime.fileContents.size).toBe(0);
    expect(runtime.directories.size).toBe(0);
    expect(runtime.events).not.toContain(`write:${runtime.stagingDirectory()}/${CLAUDE_AGENT_SDK_ENTRY_FILE}`);
  });

  it.each(['exit code', 'exception'])('reports missing npm before touching storage: %s', async (failure) => {
    const runtime = new MemoryRuntime();
    runtime.fileContents.set(`${DIRECTORY}/existing`, 'preserved');
    runtime.execHandler = async () => {
      if (failure === 'exception') throw new Error('spawn npm ENOENT');
      return result(127, 'npm not found');
    };

    await expect(installManagedClaudeAgentSdk(runtime)).resolves.toMatchObject({
      available: false,
      reason: expect.stringContaining('npm is required'),
    });
    expect(runtime.events).toEqual([`read:${ENTRY}`, 'exec:npm --version']);
    expect(runtime.fileContents.get(`${DIRECTORY}/existing`)).toBe('preserved');
  });

  it('requires move support before executing npm or modifying the target', async () => {
    const runtime = new MemoryRuntime();
    runtime.files = undefined;
    runtime.fileContents.set(`${DIRECTORY}/existing`, 'preserved');
    await expect(installManagedClaudeAgentSdk(runtime)).resolves.toMatchObject({
      available: false,
      reason: expect.stringContaining('requires runtime file move support'),
    });
    expect(runtime.events).toEqual([`read:${ENTRY}`]);
    expect(runtime.execCalls).toEqual([]);
    expect(runtime.fileContents.get(`${DIRECTORY}/existing`)).toBe('preserved');
  });

  it('cleans staging when promotion fails', async () => {
    const runtime = new MemoryRuntime();
    runtime.files!.move = async () => { throw new Error('rename failed'); };
    await expect(installManagedClaudeAgentSdk(runtime)).resolves.toMatchObject({
      available: false,
      reason: expect.stringContaining('rename failed'),
    });
    expect(runtime.fileContents.size).toBe(0);
    expect(runtime.directories.size).toBe(0);
  });

  it('reports failed staging cleanup without touching the previous state', async () => {
    const runtime = new MemoryRuntime();
    runtime.fileContents.set(`${DIRECTORY}/existing`, 'preserved');
    runtime.execHandler = async (args) => args[0] === 'ci' ? result(1, 'registry unavailable') : result();
    vi.spyOn(runtime.storage('agent'), 'remove').mockRejectedValue(new Error('permission denied'));
    await expect(installManagedClaudeAgentSdk(runtime)).resolves.toMatchObject({
      available: false,
      reason: expect.stringContaining('Could not remove the staging installation: permission denied'),
    });
    expect(runtime.fileContents.get(`${DIRECTORY}/existing`)).toBe('preserved');
  });
});

describe('unsupported managed Claude Agent SDK runtimes', () => {
  it.each(['docker', 'daytona'] as const)('rejects %s without accessing storage or executing npm', async (kind) => {
    const runtime = new MemoryRuntime(kind);
    for (const operation of [inspectClaudeCodeRuntime, installManagedClaudeAgentSdk]) {
      await expect(operation(runtime)).resolves.toEqual({
        available: false,
        reason: 'The managed Claude Agent SDK requires a host runtime.',
      });
    }
    expect(runtime.storageScopes).toEqual([]);
    expect(runtime.events).toEqual([]);
  });

  it.each(['C:\\agent-storage', 'C:/agent-storage', '\\\\server\\share'])('rejects Windows storage %s', async (root) => {
    const runtime = new MemoryRuntime('host', root);
    for (const operation of [inspectClaudeCodeRuntime, installManagedClaudeAgentSdk]) {
      await expect(operation(runtime)).resolves.toMatchObject({
        available: false,
        reason: expect.stringContaining('Windows paths are not supported'),
      });
    }
    expect(runtime.events).toEqual([]);
  });

  it.each(['win32', 'freebsd'] as const)('rejects unsupported process platform %s', async (platform) => {
    setPlatform(platform, 'x64');
    const runtime = new MemoryRuntime();
    for (const operation of [inspectClaudeCodeRuntime, installManagedClaudeAgentSdk]) {
      await expect(operation(runtime)).resolves.toMatchObject({ available: false });
    }
    expect(runtime.events).toEqual([]);
    expect(runtime.execCalls).toEqual([]);
  });
});
