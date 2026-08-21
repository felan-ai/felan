import type {
  AgentRuntime,
  AgentRuntimeStorage,
  ExecOptions,
  ExecResult,
} from '@felan-ai/agent-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

const cryptoMock = vi.hoisted(() => ({
  sha512: undefined as string | undefined,
  sha256: undefined as string | undefined,
}));

vi.mock('node:crypto', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:crypto')>();
  return {
    ...original,
    createHash: (algorithm: string) => {
      const mocked = algorithm === 'sha512' ? cryptoMock.sha512 : cryptoMock.sha256;
      if (!mocked) return original.createHash(algorithm);
      return {
        update: () => ({ digest: () => mocked }),
      };
    },
  };
});

import {
  inspectAgentBrowserRuntime,
  invalidateAgentBrowserRuntimeCache,
  installManagedAgentBrowser,
  managedAgentBrowserDirectory,
  managedAgentBrowserExecutable,
  MANAGED_AGENT_BROWSER_VERSION,
  resolveReviewedAgentBrowserAsset,
} from '../src/installer.js';

const REVIEWED_ARCHIVE_SHA512 = 'RjgfT0EsHe1oZQbwzUqJTPb7w3sU8DGbbAjMxLNI5dW1y0cc81TbVsqgjqQJmsy3GEbEcKe/ryARwmWGqJAXXQ==';
const REVIEWED_DARWIN_ARM64_SHA256 = 'fd7acd17b3071ff7f75a03c1ecd30501959d9c2d063bdaa05adb6f77abf2a7bf';
const SEEDED_INSTALLATION_ID = '00000000-0000-4000-8000-000000000000';

afterEach(() => {
  cryptoMock.sha512 = undefined;
  cryptoMock.sha256 = undefined;
});

describe('agent-browser runtime installation', () => {
  it('maps only reviewed native release assets', () => {
    expect(resolveReviewedAgentBrowserAsset('darwin', 'arm64')).toEqual({
      name: 'agent-browser-darwin-arm64',
      sha256: REVIEWED_DARWIN_ARM64_SHA256,
    });
    expect(resolveReviewedAgentBrowserAsset('linux', 'x64', true)?.name).toBe(
      'agent-browser-linux-musl-x64',
    );
    expect(resolveReviewedAgentBrowserAsset('win32', 'arm64')?.name).toBe(
      'agent-browser-win32-x64.exe',
    );
    expect(resolveReviewedAgentBrowserAsset('freebsd', 'x64')).toBeUndefined();
    expect(resolveReviewedAgentBrowserAsset('linux', 'ppc64')).toBeUndefined();
  });

  it('uses an agent-storage package path and prefers managed detection over PATH', async () => {
    cryptoMock.sha256 = REVIEWED_DARWIN_ARM64_SHA256;
    const runtime = new MemoryRuntime(async (command) => (
      command.includes('agent-browser-darwin-arm64')
        ? result(`agent-browser ${MANAGED_AGENT_BROWSER_VERSION}\n`)
        : result('', 127, 'not found')
    ));
    seedManagedInstallation(runtime);
    const environment = { platform: 'darwin' as const, arch: 'arm64' };

    expect(managedAgentBrowserDirectory(runtime)).toBe(
      `/agent/browser/agent-browser-${MANAGED_AGENT_BROWSER_VERSION}`,
    );
    await expect(managedAgentBrowserExecutable(runtime, environment)).resolves.toBe(
      `/agent/browser/agent-browser-${MANAGED_AGENT_BROWSER_VERSION}/installs/${SEEDED_INSTALLATION_ID}/bin/agent-browser-darwin-arm64`,
    );
    await expect(inspectAgentBrowserRuntime(runtime, environment)).resolves.toMatchObject({
      available: true,
      invocation: { source: 'managed', version: MANAGED_AGENT_BROWSER_VERSION },
    });
    expect(runtime.execCalls.some((call) => call.command === 'agent-browser')).toBe(false);
  });

  it('does not execute an unmarked or digest-mismatched managed binary', async () => {
    cryptoMock.sha256 = 'changed';
    const runtime = new MemoryRuntime(async (command) => (
      command === 'agent-browser'
        ? result(`agent-browser ${MANAGED_AGENT_BROWSER_VERSION}`)
        : result('', 1, 'managed binary must not execute')
    ));
    seedManagedInstallation(runtime);

    await expect(inspectAgentBrowserRuntime(runtime, {
      platform: 'darwin',
      arch: 'arm64',
    })).resolves.toMatchObject({
      available: true,
      invocation: { source: 'path' },
    });
    expect(runtime.execCalls.some((call) => call.command.includes('/agent/'))).toBe(false);

    runtime.agent.files.delete(
      `browser/agent-browser-${MANAGED_AGENT_BROWSER_VERSION}/installs/${SEEDED_INSTALLATION_ID}/.felan-install.json`,
    );
    await inspectAgentBrowserRuntime(runtime, { platform: 'darwin', arch: 'arm64' });
    expect(runtime.execCalls.some((call) => call.command.includes('/agent/'))).toBe(false);
  });

  it('accepts a version-reporting PATH CLI and returns bounded missing diagnostics', async () => {
    const pathRuntime = new MemoryRuntime(async (command) => (
      command === 'agent-browser'
        ? result(`agent-browser ${MANAGED_AGENT_BROWSER_VERSION}`)
        : result('', 127, 'missing')
    ));
    await expect(inspectAgentBrowserRuntime(pathRuntime, {
      platform: 'darwin',
      arch: 'arm64',
    })).resolves.toMatchObject({
      available: true,
      invocation: { command: 'agent-browser', source: 'path', version: MANAGED_AGENT_BROWSER_VERSION },
    });

    const mismatched = new MemoryRuntime(async (command) => (
      command === 'agent-browser'
        ? result('agent-browser 0.34.0')
        : result('', 127, 'missing')
    ));
    await expect(inspectAgentBrowserRuntime(mismatched, {
      platform: 'darwin',
      arch: 'arm64',
    })).resolves.toMatchObject({
      available: false,
      reason: expect.stringContaining('does not match reviewed'),
    });

    const missing = new MemoryRuntime(async () => result('', 127, `missing\u0000${'x'.repeat(2_000)}`));
    const detected = await inspectAgentBrowserRuntime(missing, {
      platform: 'darwin',
      arch: 'arm64',
    });
    expect(detected).toMatchObject({ available: false });
    if (!detected.available) {
      expect(detected.reason).toContain('dependency onboarding');
      expect(detected.reason.length).toBeLessThanOrEqual(700);
      expect(detected.reason).not.toContain('\u0000');
    }
  });

  it('briefly caches unavailable default discovery and supports explicit invalidation', async () => {
    const runtime = new MemoryRuntime(async () => result('', 127, 'missing'));

    await inspectAgentBrowserRuntime(runtime);
    await inspectAgentBrowserRuntime(runtime);
    expect(runtime.execCalls.filter((call) => call.command === 'agent-browser')).toHaveLength(1);

    invalidateAgentBrowserRuntimeCache(runtime);
    await inspectAgentBrowserRuntime(runtime);
    expect(runtime.execCalls.filter((call) => call.command === 'agent-browser')).toHaveLength(2);
  });

  it('downloads and verifies the pinned archive, bundled skill, binary, and exact version', async () => {
    cryptoMock.sha512 = REVIEWED_ARCHIVE_SHA512;
    cryptoMock.sha256 = REVIEWED_DARWIN_ARM64_SHA256;
    let runtime!: MemoryRuntime;
    let extractedRelativePath: string | undefined;
    runtime = new MemoryRuntime(async (command, args) => {
      if (command === 'curl') {
        runtime.writeAbsolute(args.at(-1)!, Uint8Array.from([1, 2, 3]));
        return result();
      }
      if (command === 'tar') {
        extractedRelativePath = writeExtractedPackage(runtime, args);
        return result();
      }
      if (command === 'chmod') return result();
      if (command.endsWith('agent-browser-darwin-arm64')) {
        return result(`agent-browser ${MANAGED_AGENT_BROWSER_VERSION}`);
      }
      return result('', 127, 'unexpected command');
    });
    const statuses: string[] = [];

    const installed = await installManagedAgentBrowser(
      runtime,
      (status) => statuses.push(status),
      { platform: 'darwin', arch: 'arm64' },
    );

    expect(installed).toMatchObject({
      available: true,
      invocation: {
        command: expect.stringMatching(new RegExp(
          `^/agent/browser/agent-browser-${MANAGED_AGENT_BROWSER_VERSION.replaceAll('.', '\\.')}/installs/[0-9a-f-]{36}/bin/agent-browser-darwin-arm64$`,
          'u',
        )),
        source: 'managed',
        version: MANAGED_AGENT_BROWSER_VERSION,
      },
    });
    const curl = runtime.execCalls.find((call) => call.command === 'curl');
    expect(curl?.args).toEqual(expect.arrayContaining([
      '--proto',
      '=https',
      `https://registry.npmjs.org/agent-browser/-/agent-browser-${MANAGED_AGENT_BROWSER_VERSION}.tgz`,
    ]));
    expect(extractedRelativePath).toBeDefined();
    const extractedPath = `/agent/${extractedRelativePath!}`;
    expect(runtime.execCalls.find((call) => call.command === 'tar')?.args).toEqual([
      '-xzf',
      expect.stringMatching(/\/session\/browser\/install-.+\.tgz$/u),
      '-C',
      extractedPath,
      '--strip-components=1',
    ]);
    expect(runtime.execCalls.find((call) => call.command === 'chmod')?.args).toEqual([
      '755',
      `${extractedPath}/bin/agent-browser-darwin-arm64`,
    ]);
    expect(statuses).toHaveLength(3);
    expect(runtime.session.files.size).toBe(0);
    expect(runtime.agent.files.has(
      `${extractedRelativePath!}/.felan-install.json`,
    )).toBe(true);
    await expect(inspectAgentBrowserRuntime(runtime, {
      platform: 'darwin',
      arch: 'arm64',
    })).resolves.toMatchObject({ available: true, invocation: { source: 'managed' } });
  });

  it('refuses changed archives and unsupported hosts without extracting anything', async () => {
    cryptoMock.sha512 = 'changed';
    const runtime = new MemoryRuntime(async (command, args) => {
      if (command === 'curl') {
        runtime.writeAbsolute(args.at(-1)!, Uint8Array.from([1]));
        return result();
      }
      return result();
    });
    const changed = await installManagedAgentBrowser(runtime, () => {}, {
      platform: 'darwin',
      arch: 'arm64',
    });
    expect(changed).toMatchObject({ available: false, reason: expect.stringContaining('SHA-512') });
    expect(runtime.execCalls.some((call) => call.command === 'tar')).toBe(false);
    expect(runtime.agent.files.size).toBe(0);

    cryptoMock.sha512 = REVIEWED_ARCHIVE_SHA512;
    let extractionRuntime!: MemoryRuntime;
    extractionRuntime = new MemoryRuntime(async (command, args) => {
      if (command === 'curl') {
        extractionRuntime.writeAbsolute(args.at(-1)!, Uint8Array.from([1]));
        return result();
      }
      if (command === 'tar') {
        const packagePath = args[args.indexOf('-C') + 1]!;
        const packageRelativePath = packagePath.slice('/agent/'.length);
        extractionRuntime.agent.files.set(
          `${packageRelativePath}/partial`,
          Uint8Array.from([1]),
        );
        return result('', 1, 'extract failed');
      }
      return result();
    });
    await expect(installManagedAgentBrowser(extractionRuntime, () => {}, {
      platform: 'darwin',
      arch: 'arm64',
    })).resolves.toMatchObject({ available: false, reason: expect.stringContaining('extract') });
    expect(extractionRuntime.agent.files.size).toBe(0);

    const unsupported = await installManagedAgentBrowser(runtime, () => {}, {
      platform: 'freebsd',
      arch: 'x64',
    });
    expect(unsupported).toMatchObject({
      available: false,
      reason: expect.stringContaining('freebsd-x64'),
    });
  });

  it('does not select the controller platform for non-host runtimes', async () => {
    const runtime = new MemoryRuntime(
      async (command) => command === 'agent-browser'
        ? result(`agent-browser ${MANAGED_AGENT_BROWSER_VERSION}`)
        : result('', 127, 'not found'),
      'docker',
    );

    await expect(inspectAgentBrowserRuntime(runtime)).resolves.toMatchObject({
      available: true,
      invocation: { command: 'agent-browser', source: 'path' },
    });
    expect(runtime.execCalls.map((call) => call.command)).toEqual(['agent-browser']);
    await expect(installManagedAgentBrowser(runtime)).resolves.toMatchObject({
      available: false,
      reason: expect.stringContaining('host runtimes'),
    });
  });

  it('isolates concurrent managed installations in separately verified directories', async () => {
    cryptoMock.sha512 = REVIEWED_ARCHIVE_SHA512;
    cryptoMock.sha256 = REVIEWED_DARWIN_ARM64_SHA256;
    let runtime!: MemoryRuntime;
    runtime = new MemoryRuntime(async (command, args) => {
      if (command === 'curl') {
        runtime.writeAbsolute(args.at(-1)!, Uint8Array.from([1]));
        return result();
      }
      if (command === 'tar') {
        writeExtractedPackage(runtime, args);
        return result();
      }
      if (command === 'chmod') return result();
      if (command.endsWith('agent-browser-darwin-arm64')) {
        return result(`agent-browser ${MANAGED_AGENT_BROWSER_VERSION}`);
      }
      return result('', 127, 'unexpected command');
    });

    const installations = await Promise.all([
      installManagedAgentBrowser(runtime, () => {}, { platform: 'darwin', arch: 'arm64' }),
      installManagedAgentBrowser(runtime, () => {}, { platform: 'darwin', arch: 'arm64' }),
    ]);

    expect(installations).toEqual([
      expect.objectContaining({ available: true }),
      expect.objectContaining({ available: true }),
    ]);
    if (!installations[0]?.available || !installations[1]?.available) throw new Error('install failed');
    expect(installations[0].invocation.command).not.toBe(installations[1].invocation.command);
    expect([...runtime.agent.files.keys()].filter((path) => path.endsWith('/.felan-install.json')))
      .toHaveLength(2);
  });
});

class MemoryStorage implements AgentRuntimeStorage {
  readonly files = new Map<string, Uint8Array>();

  constructor(readonly root: string) {}

  async readFile(path: string): Promise<Uint8Array> {
    const content = this.files.get(normalize(path));
    if (!content) throw Object.assign(new Error(`Missing ${path}`), { code: 'ENOENT' });
    return content.slice();
  }

  async writeFile(path: string, content: Uint8Array): Promise<void> {
    this.files.set(normalize(path), content.slice());
  }

  async listFiles(path: string): Promise<string[]> {
    const prefix = `${normalize(path)}/`;
    return [...this.files.keys()]
      .filter((entry) => entry.startsWith(prefix))
      .map((entry) => entry.slice(prefix.length));
  }

  async mkdir(): Promise<void> {}

  async remove(path: string, options?: { recursive?: boolean }): Promise<void> {
    const normalized = normalize(path);
    if (options?.recursive) {
      for (const key of [...this.files.keys()]) {
        if (key === normalized || key.startsWith(`${normalized}/`)) this.files.delete(key);
      }
      return;
    }
    this.files.delete(normalized);
  }
}

class MemoryRuntime implements AgentRuntime {
  readonly cwd = '/workspace';
  readonly session = new MemoryStorage('/session');
  readonly agent = new MemoryStorage('/agent');
  readonly execCalls: Array<{ command: string; args: readonly string[]; options?: ExecOptions }> = [];

  constructor(
    readonly handler: (
      command: string,
      args: readonly string[],
      options?: ExecOptions,
    ) => Promise<ExecResult>,
    readonly kind: AgentRuntime['kind'] = 'host',
  ) {}

  storage(scope: 'session' | 'agent' = 'session'): AgentRuntimeStorage {
    return scope === 'agent' ? this.agent : this.session;
  }

  writeAbsolute(path: string, content: Uint8Array): void {
    if (path.startsWith(`${this.session.root}/`)) {
      this.session.files.set(path.slice(this.session.root.length + 1), content.slice());
      return;
    }
    if (path.startsWith(`${this.agent.root}/`)) {
      this.agent.files.set(path.slice(this.agent.root.length + 1), content.slice());
      return;
    }
    throw new Error(`Unexpected absolute path: ${path}`);
  }

  async exec(command: string, args: readonly string[], options?: ExecOptions): Promise<ExecResult> {
    this.execCalls.push({ command, args: [...args], ...(options ? { options } : {}) });
    return this.handler(command, args, options);
  }

  async shell(): Promise<ExecResult> { throw new Error('unused'); }
  async readFile(): Promise<Uint8Array> { throw new Error('unused'); }
  async writeFile(
    path: string,
    content: Uint8Array,
    options?: { readonly exclusive?: boolean },
  ): Promise<void> {
    if (!path.startsWith(`${this.agent.root}/`)) throw new Error(`Unexpected write path: ${path}`);
    const relativePath = path.slice(this.agent.root.length + 1);
    if (options?.exclusive && this.agent.files.has(relativePath)) {
      throw Object.assign(new Error(`Exists: ${path}`), { code: 'EEXIST' });
    }
    this.agent.files.set(relativePath, content.slice());
  }
  async listFiles(): Promise<string[]> { throw new Error('unused'); }
  async mkdir(): Promise<void> { throw new Error('unused'); }
  async remove(): Promise<void> { throw new Error('unused'); }
}

function result(stdout = '', code = 0, stderr = ''): ExecResult {
  return { stdout, stderr, code, killed: false };
}

function normalize(path: string): string {
  return path.replace(/^[/\\]+/u, '').replace(/\\/gu, '/');
}

function seedManagedInstallation(runtime: MemoryRuntime): void {
  const root = `browser/agent-browser-${MANAGED_AGENT_BROWSER_VERSION}/installs/${SEEDED_INSTALLATION_ID}`;
  runtime.agent.files.set(
    `${root}/package.json`,
    new TextEncoder().encode(JSON.stringify({ name: 'agent-browser', version: MANAGED_AGENT_BROWSER_VERSION })),
  );
  runtime.agent.files.set(`${root}/skill-data/core/SKILL.md`, new TextEncoder().encode('# core'));
  runtime.agent.files.set(`${root}/bin/agent-browser-darwin-arm64`, Uint8Array.from([4, 5, 6]));
  runtime.agent.files.set(
    `${root}/.felan-install.json`,
    new TextEncoder().encode(JSON.stringify({
      schemaVersion: 1,
      package: 'agent-browser',
      version: MANAGED_AGENT_BROWSER_VERSION,
      archiveSha512: REVIEWED_ARCHIVE_SHA512,
      asset: 'agent-browser-darwin-arm64',
      assetSha256: REVIEWED_DARWIN_ARM64_SHA256,
    })),
  );
}

function writeExtractedPackage(runtime: MemoryRuntime, args: readonly string[]): string {
  const packagePath = args[args.indexOf('-C') + 1]!;
  const packageRelativePath = packagePath.slice(`${runtime.agent.root}/`.length);
  runtime.agent.files.set(
    `${packageRelativePath}/package.json`,
    new TextEncoder().encode(JSON.stringify({
      name: 'agent-browser',
      version: MANAGED_AGENT_BROWSER_VERSION,
    })),
  );
  runtime.agent.files.set(
    `${packageRelativePath}/skill-data/core/SKILL.md`,
    new TextEncoder().encode('# core'),
  );
  runtime.agent.files.set(
    `${packageRelativePath}/bin/agent-browser-darwin-arm64`,
    Uint8Array.from([4, 5, 6]),
  );
  return packageRelativePath;
}
