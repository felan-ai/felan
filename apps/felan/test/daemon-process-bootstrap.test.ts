import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const paths: string[] = [];
let initializeLocalDaemonProcess: typeof import('../src/providers/process-bootstrap.js').initializeLocalDaemonProcess;
type HttpBootstrap = Awaited<ReturnType<NonNullable<Parameters<typeof initializeLocalDaemonProcess>[1]>>>;

beforeEach(async () => {
  vi.resetModules();
  ({ initializeLocalDaemonProcess } = await import('../src/providers/process-bootstrap.js'));
  for (const name of ['PI_CODING_AGENT_DIR', 'PI_SKIP_VERSION_CHECK', 'PI_TELEMETRY', 'HTTP_PROXY', 'HTTPS_PROXY']) {
    vi.stubEnv(name, undefined);
  }
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function temporaryAgentDirectory(settings?: string) {
  const root = await mkdtemp(join(tmpdir(), 'felan-bootstrap-'));
  paths.push(root);
  const agentDir = join(root, 'agent');
  await mkdir(agentDir);
  if (settings !== undefined) await writeFile(join(agentDir, 'settings.json'), settings);
  return { root, agentDir };
}

async function httpLoader() {
  const http = await import(new URL('./core/http-dispatcher.js', import.meta.resolve('@earendil-works/pi-coding-agent')).href) as HttpBootstrap;
  const adapter = {
    ...http,
    applyHttpProxySettings: vi.fn(http.applyHttpProxySettings),
    configureHttpDispatcher: vi.fn<(timeoutMs: number) => void>(),
  };
  return { adapter, load: vi.fn(async () => adapter) };
}

describe('daemon process initialization from source', () => {
  it('initializes once with normalized arguments and retains the successful launch configuration', async () => {
    const { agentDir } = await temporaryAgentDirectory(JSON.stringify({
      httpProxy: '  http://127.0.0.1:9123  ', httpIdleTimeoutMs: ' 45000.9 ',
    }));
    const { adapter, load } = await httpLoader();
    vi.stubEnv('HTTP_PROXY', 'http://127.0.0.1:9000');

    const first = initializeLocalDaemonProcess(join(agentDir, '..', 'agent'), load);
    expect(initializeLocalDaemonProcess(agentDir, load)).toBe(first);
    const state = await first;

    expect(state.diagnostics).toEqual([]);
    expect(load).toHaveBeenCalledOnce();
    expect(adapter.applyHttpProxySettings).toHaveBeenCalledExactlyOnceWith('http://127.0.0.1:9123');
    expect(adapter.configureHttpDispatcher).toHaveBeenCalledExactlyOnceWith(45000);
    expect(process.env.PI_CODING_AGENT_DIR).toBe(agentDir);
    expect(process.env.PI_SKIP_VERSION_CHECK).toBe('1');
    expect(process.env.PI_TELEMETRY).toBe('0');
    expect(process.env.HTTP_PROXY).toBe('http://127.0.0.1:9000');
    expect(process.env.HTTPS_PROXY).toBe('http://127.0.0.1:9123');

    const environment = { ...process.env };
    expect(state.assertConfiguration({ httpProxy: 'http://127.0.0.1:9123', httpIdleTimeoutMs: 45000 })).toEqual([]);
    expect(state.assertConfiguration({ httpProxy: 42, httpIdleTimeoutMs: -1 })).toEqual([
      { type: 'warning', message: expect.stringContaining('httpProxy') },
      { type: 'warning', message: expect.stringContaining('httpIdleTimeoutMs') },
    ]);
    expect(state.assertConfiguration({ httpProxy: 'not a URL', httpIdleTimeoutMs: 45000 })).toEqual([
      { type: 'warning', message: expect.stringContaining('httpProxy') },
    ]);
    expect(state.assertConfiguration({ httpProxy: 'http://127.0.0.1:9123', httpIdleTimeoutMs: 'invalid' })).toEqual([
      { type: 'warning', message: expect.stringContaining('httpIdleTimeoutMs') },
    ]);
    expect(() => state.assertConfiguration({ httpProxy: 'http://127.0.0.1:9999', httpIdleTimeoutMs: 45000 })).toThrow(/proxy.*restart/u);
    expect(() => state.assertConfiguration({ httpProxy: 'http://127.0.0.1:9123', httpIdleTimeoutMs: 60000 })).toThrow(/idle timeout.*restart/u);
    expect(() => initializeLocalDaemonProcess(join(agentDir, 'other'), load)).toThrow(/directory.*restart/u);
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ httpProxy: 'http://changed:9000', httpIdleTimeoutMs: 9000 }));
    expect(initializeLocalDaemonProcess(agentDir, load)).toBe(first);
    expect(await initializeLocalDaemonProcess(agentDir, load)).toBe(state);
    expect(load).toHaveBeenCalledOnce();
    expect(adapter.applyHttpProxySettings).toHaveBeenCalledTimes(1);
    expect(adapter.configureHttpDispatcher).toHaveBeenCalledTimes(1);
    expect(process.env).toEqual(environment);
  });

  it.each(['{ "theme": "dark", ', 'null', '"not settings"'])('warns and starts with defaults for invalid settings: %s', async (settings) => {
    const { agentDir } = await temporaryAgentDirectory(settings);
    const { adapter, load } = await httpLoader();
    const state = await initializeLocalDaemonProcess(agentDir, load);

    expect(state.diagnostics).toEqual([{ type: 'warning', message: expect.stringContaining('global settings') }]);
    expect(adapter.applyHttpProxySettings).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(adapter.configureHttpDispatcher).toHaveBeenCalledExactlyOnceWith(adapter.DEFAULT_HTTP_IDLE_TIMEOUT_MS);
    expect(process.env.PI_CODING_AGENT_DIR).toBe(agentDir);
  });

  it.each([42, {}, true, 'not a URL', 'socks5://localhost:9000', 'http://user:private@%invalid'])('warns and ignores an invalid proxy: %j', async (httpProxy) => {
    const { agentDir } = await temporaryAgentDirectory(JSON.stringify({ httpProxy }));
    const { adapter, load } = await httpLoader();
    const state = await initializeLocalDaemonProcess(agentDir, load);

    expect(state.diagnostics).toEqual([{ type: 'warning', message: expect.stringContaining('httpProxy') }]);
    expect(JSON.stringify(state.diagnostics)).not.toContain('private');
    expect(adapter.applyHttpProxySettings).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(process.env.HTTPS_PROXY).toBeUndefined();
    expect(process.env.PI_CODING_AGENT_DIR).toBe(agentDir);
  });

  it.each([-1, '', 'later', null])('warns and uses the default for invalid idle timeout: %j', async (httpIdleTimeoutMs) => {
    const { agentDir } = await temporaryAgentDirectory(JSON.stringify({ httpIdleTimeoutMs }));
    const { adapter, load } = await httpLoader();
    const state = await initializeLocalDaemonProcess(agentDir, load);

    expect(state.diagnostics).toEqual([{ type: 'warning', message: expect.stringContaining('httpIdleTimeoutMs') }]);
    expect(adapter.configureHttpDispatcher).toHaveBeenCalledExactlyOnceWith(adapter.DEFAULT_HTTP_IDLE_TIMEOUT_MS);
    expect(() => state.assertConfiguration({})).not.toThrow();
  });

  it.each([0, ' disabled ', '0'])('normalizes disabled idle timeouts: %j', async (httpIdleTimeoutMs) => {
    const { agentDir } = await temporaryAgentDirectory(JSON.stringify({ httpProxy: '  ', httpIdleTimeoutMs }));
    const { adapter, load } = await httpLoader();
    const state = await initializeLocalDaemonProcess(agentDir, load);

    expect(state.diagnostics).toEqual([]);
    expect(adapter.applyHttpProxySettings).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(adapter.configureHttpDispatcher).toHaveBeenCalledExactlyOnceWith(0);
    expect(() => state.assertConfiguration({ httpIdleTimeoutMs: 'disabled' })).not.toThrow();
    expect(() => state.assertConfiguration({})).toThrow(/idle timeout.*restart/u);
  });

  it('uses global defaults without a settings file and accepts unrelated environment prefixes', async () => {
    const { agentDir } = await temporaryAgentDirectory();
    const { adapter, load } = await httpLoader();
    vi.stubEnv('FELAN_DAEMON_TEST_OPTION', 'allowed');
    vi.stubEnv('FELAN_IPC_TEST_OPTION', 'allowed');
    const state = await initializeLocalDaemonProcess(agentDir, load);

    expect(state.diagnostics).toEqual([]);
    expect(() => state.assertConfiguration({ httpIdleTimeoutMs: adapter.DEFAULT_HTTP_IDLE_TIMEOUT_MS })).not.toThrow();
    expect(adapter.configureHttpDispatcher).toHaveBeenCalledExactlyOnceWith(adapter.DEFAULT_HTTP_IDLE_TIMEOUT_MS);
    expect(process.env.FELAN_DAEMON_TEST_OPTION).toBe('allowed');
    expect(process.env.FELAN_IPC_TEST_OPTION).toBe('allowed');
  });

  it('retries a rejected HTTP loader and rereads the corrected settings file', async () => {
    const { agentDir } = await temporaryAgentDirectory('{ "httpProxy":');
    const { adapter, load } = await httpLoader();
    load.mockRejectedValueOnce(new Error('HTTP loader failed'));
    const failed = initializeLocalDaemonProcess(agentDir, load);
    expect(initializeLocalDaemonProcess(agentDir, load)).toBe(failed);
    await expect(failed).rejects.toThrow('HTTP loader failed');
    expect(process.env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(adapter.configureHttpDispatcher).not.toHaveBeenCalled();

    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ httpProxy: 'https://localhost:9123', httpIdleTimeoutMs: 1234 }));
    const retried = initializeLocalDaemonProcess(agentDir, load);
    expect(retried).not.toBe(failed);
    const state = await retried;
    expect(state.diagnostics).toEqual([]);
    expect(load).toHaveBeenCalledTimes(2);
    expect(adapter.applyHttpProxySettings).toHaveBeenCalledExactlyOnceWith('https://localhost:9123');
    expect(adapter.configureHttpDispatcher).toHaveBeenCalledExactlyOnceWith(1234);
    expect(process.env.HTTPS_PROXY).toBe('https://localhost:9123');
    expect(initializeLocalDaemonProcess(agentDir, load)).toBe(retried);
  });

  it('fails closed for an incompatible private adapter, without caching the failure', async () => {
    const { agentDir } = await temporaryAgentDirectory();
    const { adapter, load } = await httpLoader();
    const incompatible = async () => ({ ...adapter, configureHttpDispatcher: undefined }) as unknown as HttpBootstrap;
    await expect(initializeLocalDaemonProcess(agentDir, incompatible)).rejects.toThrow('incompatible');
    expect(process.env.PI_CODING_AGENT_DIR).toBeUndefined();
    await expect(initializeLocalDaemonProcess(agentDir, load)).resolves.toHaveProperty('diagnostics', []);
    expect(adapter.configureHttpDispatcher).toHaveBeenCalledOnce();
  });
});

async function runScript(script: string, extraEnvironment: Record<string, string> = {}) {
  const { root, agentDir } = await temporaryAgentDirectory(JSON.stringify({ httpProxy: 'http://127.0.0.1:9123', httpIdleTimeoutMs: 45000 }));
  const source = `import { initializeLocalDaemonProcess } from ${JSON.stringify(new URL('../dist/providers/process-bootstrap.js', import.meta.url).href)};
    import { writeFile } from 'node:fs/promises';
    const agentDir = ${JSON.stringify(agentDir)};
    ${script}`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: new URL('../../daemon', import.meta.url), encoding: 'utf8', timeout: 20_000,
    env: { PATH: process.env.PATH ?? '', HOME: root, PI_OFFLINE: '1', HTTP_PROXY: 'http://127.0.0.1:9000', ...extraEnvironment },
  });
}

describe.skipIf(process.env.FELAN_TEST_DIST_SMOKE !== '1')('built package smoke (requires pnpm --filter @felan-ai/felan build)', () => {
  it('loads the package export and the real pinned private HTTP adapter', async () => {
    const result = await runScript(`
      const profile = await import('@felan-ai/daemon/session-runtime');
      if (profile.SESSION_RUNTIME_SERVICE.key !== 'felan.session-runtime@1') throw new Error('session-runtime export missing');
      const first = initializeLocalDaemonProcess(agentDir);
      const second = initializeLocalDaemonProcess(agentDir);
      if (first !== second) throw new Error('initialization was repeated');
      const state = await first;
      if (state.diagnostics.length) throw new Error('unexpected diagnostics');
      if (process.env.PI_CODING_AGENT_DIR !== agentDir || process.env.PI_SKIP_VERSION_CHECK !== '1' || process.env.PI_TELEMETRY !== '0') throw new Error('Pi setup missing');
      if (process.env.HTTP_PROXY !== 'http://127.0.0.1:9000' || process.env.HTTPS_PROXY !== 'http://127.0.0.1:9123') throw new Error('proxy setup mismatch');
      const before = JSON.stringify(process.env);
      state.assertConfiguration({httpProxy:'http://127.0.0.1:9123', httpIdleTimeoutMs:45000});
      let refused = false;
      try { state.assertConfiguration({httpProxy:'http://127.0.0.1:9999', httpIdleTimeoutMs:45000}); } catch (error) { refused = error.message.includes('restart'); }
      if (!refused || JSON.stringify(process.env) !== before) throw new Error('live proxy changes were allowed');
      await writeFile(agentDir + '/settings.json', JSON.stringify({httpProxy:'http://127.0.0.1:9999'}));
      if (await initializeLocalDaemonProcess(agentDir) !== state) throw new Error('state changed');
      if (JSON.stringify(process.env) !== before) throw new Error('environment changed after startup');
      console.log('ok');
    `);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('ok');
  });

  it('preserves stored command credentials and model headers under the shared launch environment', async () => {
    const result = await runScript(`
      const { createLocalModelRuntime } = await import(${JSON.stringify(new URL('../dist/providers/local-model-runtime.js', import.meta.url).href)});
      await writeFile(agentDir + '/auth.json', JSON.stringify({ openai: { type:'api_key', key:'!printf synthetic-command-key' } }));
      await writeFile(agentDir + '/models.json', JSON.stringify({ providers: { openai: { headers: { 'X-Launch': '$S105_HEADER' } } } }));
      const a = await createLocalModelRuntime(agentDir);
      if (process.env.PI_CODING_AGENT_DIR !== agentDir || process.env.PI_SKIP_VERSION_CHECK !== '1' || process.env.PI_TELEMETRY !== '0') throw new Error('Model runtime skipped process initialization');
      if (process.env.HTTPS_PROXY !== 'http://127.0.0.1:9123') throw new Error('Model runtime skipped proxy initialization');
      const b = await createLocalModelRuntime(agentDir);
      const model = a.getModels('openai')[0];
      const auth = await a.getAuth(model);
      if (auth.auth.apiKey !== 'synthetic-command-key' || auth.auth.headers['X-Launch'] !== 'launch-value') throw new Error('provider compatibility lost');
      if (!b.getModels('anthropic').length || !b.getModels('openai-codex').length) throw new Error('provider removed');
      console.log('compatible');
    `, { S105_HEADER: 'launch-value' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('compatible');
  });
});
