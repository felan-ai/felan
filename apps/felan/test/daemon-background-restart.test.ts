import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InMemoryCredentialStore, ModelRuntime, createAssistantMessageEventStream,
  type AssistantMessage, type Context,
} from '@felan-ai/agent-core';
import { afterEach, expect, it, vi } from 'vitest';
import { startDaemonService } from '../../daemon/src/daemon/service.js';
import { acquireDaemonOwnership } from '../../daemon/src/daemon/ownership.js';
import { offlineModel } from '../../daemon/test/fixtures/registry.js';
import { SessionClient } from '../src/client/client.js';
import { FELAN_VERSION } from '../src/version.js';

const TEST_TIMEOUT_MS = 90_000;
const WAIT_MS = 20_000;
const NOTICE = 'Background process reached terminal status';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function assistant(content: AssistantMessage['content']): AssistantMessage {
  const stopReason = content.some(item => item.type === 'toolCall') ? 'toolUse' : 'stop';
  return { role: 'assistant', content, stopReason, api: offlineModel.api, provider: offlineModel.provider, model: offlineModel.id,
    timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

function messageText(message: Context['messages'][number]): string {
  if (typeof message.content === 'string') return message.content;
  return message.content.map(item => item.type === 'text' ? item.text : '').join('\n');
}

/** Starts two promoted commands on the first prompt, then answers every later call with text. */
function scriptedModel() {
  const calls: Context[] = [];
  const createModelRuntime = async () => {
    const models = await ModelRuntime.create({ modelsPath: null, credentials: new InMemoryCredentialStore(), refreshOnCreate: false });
    models.registerProvider(offlineModel.provider, { api: offlineModel.api, baseUrl: offlineModel.baseUrl, apiKey: 'fixture', models: [offlineModel],
      streamSimple: (_model, context) => {
        calls.push(structuredClone(context));
        const stream = createAssistantMessageEventStream();
        const last = context.messages.at(-1);
        const content: AssistantMessage['content'] = calls.length === 1
          ? ['a', 'b'].map(name => ({ type: 'toolCall' as const, id: `start-${name}`, name: 'bash',
            arguments: { command: `echo started-${name}; while [ ! -f ${name}.done ]; do sleep 0.05; done; echo finished-${name}; touch ${name}.finished`, timeout: 1 } }))
          : [{ type: 'text', text: last && messageText(last).includes(NOTICE) ? 'Noted the finished process.' : 'Both commands run in the background.' }];
        queueMicrotask(() => stream.push({ type: 'done', reason: content[0]!.type === 'toolCall' ? 'toolUse' : 'stop', message: assistant(content) }));
        return stream;
      } });
    return models;
  };
  return { calls, createModelRuntime };
}

it('keeps promoted commands and their finish notices across a daemon restart', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bg-restart-')));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'workspace'); await mkdir(cwd);
  const directory = join(root, 'daemon'); await mkdir(directory, { mode: 0o700 });
  const target = { kind: 'isolated' as const, directory, namespaceId: randomUUID() };
  const owner = await acquireDaemonOwnership(target);
  const hostConfigPath = join(owner.target.agentDir, 'host.json');
  try {
    const config = JSON.parse(await readFile(new URL('../src/host.json', import.meta.url), 'utf8'));
    config.extensions = [{ package: '@felan-ai/ext-background-bash' }];
    await writeFile(hostConfigPath, JSON.stringify(config), { mode: 0o600 });
  } finally { await owner.release(); }
  const model = scriptedModel();
  const start = () => startDaemonService(target, { hostConfigPath, drainTimeoutMs: WAIT_MS, createModelRuntime: model.createModelRuntime,
    manager: { packageName: '@felan-ai/felan', version: FELAN_VERSION, resolveFrom: import.meta.url,
      resolveProvider: specifier => specifier === '@felan-ai/ext-memory/daemon' ? import.meta.resolve(specifier)
        : new URL(`../src/providers/${specifier.split('/').at(-1)}.ts`, import.meta.url).href } });
  let service = await start();
  const stop = async (mode: 'drain' | 'force') => {
    if (service.lifecycle.state === 'stopped') return;
    await service.requestStop('stop', mode);
    await service.stopped;
  };
  cleanups.push(async () => {
    for (const name of ['a', 'b']) await writeFile(join(cwd, `${name}.done`), '');
    await stop('force');
  });
  const connect = async () => {
    const client = new SessionClient({ target, clientVersion: FELAN_VERSION, kind: 'tui' });
    cleanups.push(async () => client.close());
    await client.connect();
    return client;
  };
  let client = await connect();
  const created = await client.request('sessions.create', { cwd, model: { provider: offlineModel.provider, id: offlineModel.id } });
  if (created.outcome !== 'accepted') throw new Error(`Session creation failed: ${JSON.stringify(created)}`);
  const session = created.result.sessionId;
  await client.attach(session);
  expect(await client.request('prompt', { text: 'Start both commands.' }, { session })).toMatchObject({ outcome: 'accepted' });
  const store = () => service.registry.options.store;
  await vi.waitFor(() => {
    expect(model.calls).toHaveLength(2);
    expect(store().sessionMetadata(session).run.state).toBe('idle');
  }, { timeout: WAIT_MS });
  const jobs = service.registry.processes.list(session);
  expect(jobs).toHaveLength(2);
  expect(jobs).toEqual(expect.arrayContaining(['a', 'b'].map(name =>
    expect.objectContaining({ kind: 'detached', state: 'running', command: expect.stringContaining(`started-${name}`) }))));
  const jobId = (name: string) => jobs.find(job => job.command.includes(`started-${name}`))!.id;

  // Requirement 2: the promoted commands run on, but the ended run leaves no interruptible work.
  await vi.waitFor(async () => expect(await client.request('host.status', {}))
    .toMatchObject({ outcome: 'accepted', result: { active: { runs: 0, work: 0 } } }), { timeout: WAIT_MS });

  await client.close();
  await stop('drain');
  // Job a finishes while no daemon runs, so its notice is owed to the next daemon.
  await writeFile(join(cwd, 'a.done'), '');
  await vi.waitFor(() => access(join(cwd, 'a.finished')), { timeout: WAIT_MS });

  service = await start();
  client = await connect();
  // Requirement 4: recovery restores the session without a prompt.
  await vi.waitFor(() => expect(service.registry.binding(session)).toBeDefined(), { timeout: WAIT_MS });
  // Requirement 1: the promoted command is still listed as running, with readable output.
  await vi.waitFor(() => expect(service.registry.processes.list(session)).toContainEqual(
    expect.objectContaining({ id: jobId('b'), kind: 'detached', state: 'running' })), { timeout: WAIT_MS });
  const output = await service.registry.processes.read(session, jobId('b'), 0, 4096);
  expect(new TextDecoder().decode(output.data)).toContain('started-b');
  expect(output.state).toBe('running');

  // Requirement 3: the notice missed during the restart arrives once and starts a turn.
  const notices = (id: string) => (model.calls.at(-1)?.messages ?? []).filter(message => messageText(message).includes(NOTICE) && messageText(message).includes(id));
  await vi.waitFor(() => expect(notices(jobId('a'))).toHaveLength(1), { timeout: WAIT_MS });
  await writeFile(join(cwd, 'b.done'), '');
  await vi.waitFor(() => expect(notices(jobId('b'))).toHaveLength(1), { timeout: WAIT_MS });
  await vi.waitFor(() => expect(store().sessionMetadata(session).run.state).toBe('idle'), { timeout: WAIT_MS });
  await new Promise(resolve => setTimeout(resolve, 1_500));
  expect(notices(jobId('a'))).toHaveLength(1);
  expect(notices(jobId('b'))).toHaveLength(1);
  const prompts = model.calls.at(-1)!.messages.filter(message => message.role === 'user' && !messageText(message).includes(NOTICE));
  expect(prompts.map(messageText)).toEqual(['Start both commands.']);
}, TEST_TIMEOUT_MS);
