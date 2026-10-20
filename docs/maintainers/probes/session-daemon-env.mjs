import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { HostAgentRuntime, ModelRuntime } from '../../../packages/agent-core/dist/index.js';
import { resolveConfigValueUncached } from '../../../apps/tui/node_modules/@earendil-works/pi-coding-agent/dist/core/resolve-config-value.js';

const require = createRequire(new URL('../../../packages/agent-core/package.json', import.meta.url));
const pty = require('@lydell/node-pty');
const root = await mkdtemp(join(tmpdir(), 'felan-s1-env-'));
const before = JSON.stringify(process.env);
const cwdBefore = process.cwd();
const environment = (label) => ({
  PATH: dirname(process.execPath),
  HOME: join(root, label),
  FELAN_S1_CLIENT: label,
  HTTP_PROXY: `http://${label}.invalid:9999`,
  OPENAI_API_KEY: `synthetic-${label}-not-a-credential`,
});
const script = 'console.log(JSON.stringify({client:process.env.FELAN_S1_CLIENT,proxy:process.env.HTTP_PROXY,daemon:process.env.FELAN_S1_DAEMON_ONLY,cwd:process.cwd()}))';

function exec(env, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (data) => { output += data; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(`exit ${code}`)));
  });
}

function terminal(env, cwd) {
  return new Promise((resolve, reject) => {
    const child = pty.spawn(process.execPath, ['-e', script], { env, cwd, cols: 80, rows: 24 });
    let output = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('PTY probe timed out')); }, 5_000);
    child.onData((data) => { output += data; });
    child.onExit(({ exitCode }) => {
      clearTimeout(timer);
      try {
        assert.equal(exitCode, 0);
        resolve(JSON.parse(output.trim()));
      } catch (error) { reject(error); }
    });
  });
}

function contractEnvironmentValue(runtime, name, daemon) {
  if (runtime.getEnv !== undefined && typeof runtime.getEnv !== 'function') throw new Error('Invalid getEnv accessor');
  if (daemon && typeof runtime.getEnv !== 'function') throw new Error('Daemon runtime requires getEnv');
  return typeof runtime.getEnv === 'function' ? runtime.getEnv(name) : process.env[name];
}

try {
  for (const label of ['a', 'b']) await mkdir(join(root, label));
  const [a, b] = await Promise.all(['a', 'b'].map((label) => exec(environment(label), join(root, label))));
  assert.equal(a.client, 'a');
  assert.equal(b.client, 'b');
  assert.notEqual(a.proxy, b.proxy);
  assert.notEqual(a.cwd, b.cwd);
  assert.equal(a.daemon, undefined);
  assert.equal(b.daemon, undefined);
  const [ta, tb] = await Promise.all(['a', 'b'].map((label) => terminal(environment(label), join(root, label))));
  assert.equal(ta.client, 'a');
  assert.equal(tb.client, 'b');
  assert.equal(ta.daemon, undefined);
  assert.equal(tb.daemon, undefined);

  const models = await ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  const [authA, authB] = await Promise.all(['a', 'b'].map((label) => models.getAuth('openai', { env: environment(label) })));
  assert.equal(authA?.auth.apiKey, environment('a').OPENAI_API_KEY);
  assert.equal(authB?.auth.apiKey, environment('b').OPENAI_API_KEY);
  models.registerProvider('s101-probe', {
    api: 'openai-completions', baseUrl: 'https://unused.invalid', apiKey: '${FELAN_S1_CLIENT}',
    models: [{ id: 'probe', name: 'Probe', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 64 }],
  });
  const registered = models.getModel('s101-probe', 'probe');
  assert.ok(registered);
  const [registeredA, registeredB] = await Promise.all(['a', 'b'].map((label) => models.getAuth(registered, { env: environment(label) })));
  assert.equal(registeredA?.auth.apiKey, 'a');
  assert.equal(registeredB?.auth.apiKey, 'b');
  assert.equal(contractEnvironmentValue({}, 'FELAN_S1_DAEMON_ONLY', false), 'synthetic-daemon');
  assert.equal(contractEnvironmentValue({ getEnv: () => undefined }, 'FELAN_S1_DAEMON_ONLY', true), undefined);
  assert.equal(contractEnvironmentValue({ getEnv: () => '' }, 'FELAN_S1_DAEMON_ONLY', true), '');
  assert.throws(() => contractEnvironmentValue({}, 'FELAN_S1_DAEMON_ONLY', true), /requires getEnv/);
  assert.throws(() => contractEnvironmentValue({ getEnv: null }, 'FELAN_S1_DAEMON_ONLY', false), /Invalid getEnv/);
  const forwarding = (runtime) => ({ getEnv: (name) => runtime.getEnv(name) });
  for (const label of ['a', 'b']) {
    const runtime = { getEnv: (name) => environment(label)[name] };
    assert.equal(contractEnvironmentValue(forwarding(runtime), 'FELAN_S1_CLIENT', true), label);
  }
  assert.equal(resolveConfigValueUncached('${FELAN_S1_DAEMON_ONLY}', environment('a')), 'synthetic-daemon');
  const configuredCommand = `!${JSON.stringify(process.execPath)} -e ${JSON.stringify('console.log(process.env.FELAN_S1_DAEMON_ONLY)')}`;
  assert.equal(resolveConfigValueUncached(configuredCommand, environment('a')), 'synthetic-daemon');

  const runtime = new HostAgentRuntime(root, { sessionStorageRoot: join(root, 'session'), agentStorageRoot: join(root, 'agent') });
  const current = await runtime.shell(`${JSON.stringify(process.execPath)} -e ${JSON.stringify('console.log(process.env.FELAN_S1_DAEMON_ONLY)')}`, { env: environment('a') });
  assert.equal(current.code, 0);
  assert.equal(current.stdout.trim(), 'synthetic-daemon');
  assert.equal(JSON.stringify(process.env), before);
  assert.equal(process.cwd(), cwdBefore);
  console.log(JSON.stringify({
    node: process.version, platform: process.platform,
    explicit_spawn_and_cwd: 'pass: two concurrent environments, no inherited daemon sentinel',
    explicit_pty: 'pass: two concurrent environments, no inherited daemon sentinel',
    pi_getAuth_env_override: 'pass: two synthetic keys, no provider/network request',
    pi_registered_provider: 'pass: registered provider config resolves two supplied synthetic environments without network',
    getEnv_contract_fixture: 'pass: legacy absence fallback, required daemon accessor, undefined/empty values authoritative, child-wrapper forwarding; production accessor not implemented',
    pi_config_resolution: 'confirmed gaps: missing supplied env keys fall back to process.env; configured credential shell commands ignore supplied env',
    current_HostAgentRuntime: 'confirmed gap: shell env overlays ambient daemon env instead of replacing it',
    global_environment_and_cwd_unchanged: true,
    limits: 'Does not prove all provider SDKs, virtual routing, model availability, OAuth or extension credential paths are isolated.',
  }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
