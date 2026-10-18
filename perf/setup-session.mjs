import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { built, HERE, isolatedRuntime, sleep } from './lib.mjs';

export async function startProvider(ctx, overrides = {}) {
  const runtime = isolatedRuntime();
  const env = { ...process.env, FAKE_TOKENS: ctx.quick ? '100' : '400', FAKE_INTERVAL_MS: ctx.quick ? '3' : '5', SEED_TOKENS: ctx.quick ? '40' : '600', ...overrides };
  for (const key of ['FAKE_TOKENS', 'FAKE_INTERVAL_MS', 'SEED_TOKENS']) if (process.env[key]) env[key] = process.env[key];
  const provider = spawn(process.execPath, [join(HERE, 'fake-provider.mjs'), '--runtime', runtime], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let errorText = '';
  provider.stderr.on('data', data => { errorText += data; });
  let buffer = '';
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { provider.kill(); reject(new Error('Fake provider start timed out')); }, 5000);
    provider.once('error', error => { clearTimeout(timer); reject(error); });
    provider.once('exit', code => { clearTimeout(timer); reject(new Error(`Fake provider exited ${code}: ${errorText}`)); });
    provider.stdout.on('data', data => {
      buffer += data;
      if (!buffer.includes('\n')) return;
      try { const { port } = JSON.parse(buffer.trim()); clearTimeout(timer); resolve(port); }
      catch (error) { clearTimeout(timer); reject(error); }
    });
  });
  return { provider, port, tokens: Number(env.FAKE_TOKENS), interval: Number(env.FAKE_INTERVAL_MS) };
}
export async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
  try { await exited; } finally { clearTimeout(timer); }
}
export async function connect(port, instrument = false) {
  const runtime = isolatedRuntime();
  mkdirSync(join(runtime, 'agent'), { recursive: true, mode: 0o700 });
  writeFileSync(join(runtime, 'agent', 'models.json'), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions', apiKey: 'fake-local-key', models: [{ id: 'fake-model', name: 'Fake', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
  writeFileSync(join(runtime, 'agent', 'settings.json'), JSON.stringify({ defaultProvider: 'fake', defaultModel: 'fake-model' }));
  if (instrument) {
    process.env.NODE_OPTIONS = `--import=${pathToFileURL(join(HERE, 'count-commits.mjs')).href}`;
    if (process.env.DPROF_FILE) process.env.NODE_OPTIONS += ` --import=${pathToFileURL(join(HERE, 'daemon-prof.mjs')).href}`;
  }
  const { createDaemonClient } = await built('apps/felan/dist/acp/daemon-session.js');
  const client = await createDaemonClient({ daemonRuntime: runtime }, 'headless');
  await client.connect();
  return client;
}
export function accepted(response) {
  if (response.outcome !== 'accepted') throw new Error(`${response.error?.code}: ${response.error?.message}`);
  return response.result;
}
export async function createSession(client, seedTurns = 0) {
  const session = accepted(await client.request('sessions.create', { cwd: process.env.PROBE_CWD, source: 'headless' })).sessionId;
  accepted(await client.attach(session));
  accepted(await client.request('set_model', { provider: 'fake', id: 'fake-model' }, { session }));
  for (let i = 0; i < seedTurns; i++) await prompt(client, session, `seed ${i}`);
  return session;
}
export async function prompt(client, session, text, observe = () => {}) {
  let running = false;
  let finish;
  let fail;
  const done = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
  const read = () => {
    try {
      const state = client.readAttachment(session)?.state;
      if (state?.status === 'blocked') throw new Error('Client attachment blocked');
      const snap = state?.snapshot;
      if (!snap) return;
      observe(snap);
      if (snap.run.state !== 'idle') running = true;
      if (running && snap.run.state === 'idle') finish();
    } catch (error) { fail(error); }
  };
  const unsubscribe = client.subscribe(read);
  const timer = setTimeout(() => fail(new Error('Prompt did not finish within 30 seconds')), 30000);
  // Attach the rejection handler immediately, including while the request is being acknowledged.
  const completion = done.then(() => undefined);
  completion.catch(() => {});
  try {
    const response = await client.request('prompt', { text }, { session });
    accepted(response); read();
    await completion;
  } finally { clearTimeout(timer); unsubscribe(); }
}
export async function closeClient(client) {
  if (!client) return;
  try { await Promise.race([client.control('host.stop', 'force'), sleep(2000)]); } catch {}
  client.close();
}
