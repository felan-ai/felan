/** A daemon running in this process with a scripted model, for hold, restart and continue tests. */
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InMemoryCredentialStore, ModelRuntime, createAssistantMessageEventStream,
  type AssistantMessage, type Context,
} from '@felan-ai/agent-core';
import { expect, vi } from 'vitest';
import { startDaemonService } from '../../../daemon/src/daemon/service.js';
import { acquireDaemonOwnership } from '../../../daemon/src/daemon/ownership.js';
import { offlineModel } from '../../../daemon/test/fixtures/registry.js';
import { SessionClient } from '../../src/client/client.js';
import { FELAN_VERSION } from '../../src/version.js';

export const TEST_TIMEOUT_MS = 120_000;
const WAIT_MS = 30_000;
export const cleanups: Array<() => Promise<void>> = [];

function assistant(content: AssistantMessage['content']): AssistantMessage {
  const stopReason = content.some(item => item.type === 'toolCall') ? 'toolUse' : 'stop';
  return { role: 'assistant', content, stopReason, api: offlineModel.api, provider: offlineModel.provider, model: offlineModel.id,
    timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
export function text(message: Context['messages'][number]): string {
  if (typeof message.content === 'string') return message.content;
  return (message.content as Array<{ type: string; text?: string }>).map(item => item.type === 'text' ? item.text ?? '' : '').join('\n');
}
/** Appends its name to calls.log, then waits until the test creates `<name>.go`. */
const gated = (name: string) => `echo ${name} >> calls.log; while [ ! -f ${name}.go ]; do sleep 0.05; done; echo ${name}-finished`;

/**
 * Root A creates a task, starts a subagent and runs a gated command; its continued step lists the tasks. The subagent runs a
 * gated command. Root B runs a gated command. Every later request is answered with text.
 */
function scriptedModel() {
  const calls: Array<{ who: string; turn: number; context: Context }> = [];
  const createModelRuntime = async () => {
    const models = await ModelRuntime.create({ modelsPath: null, credentials: new InMemoryCredentialStore(), refreshOnCreate: false });
    models.registerProvider(offlineModel.provider, { api: offlineModel.api, baseUrl: offlineModel.baseUrl, apiKey: 'fixture', models: [offlineModel],
      streamSimple: (_model, context) => {
        const stream = createAssistantMessageEventStream();
        const users = context.messages.filter(message => message.role === 'user').map(text).join('\n');
        const who = users.includes('CHILD-A') ? 'child-a' : users.includes('ROOT-A') ? 'root-a' : users.includes('ROOT-B') ? 'root-b' : 'other';
        const turn = context.messages.filter(message => message.role === 'assistant').length;
        calls.push({ who, turn, context: structuredClone(context) });
        let content: AssistantMessage['content'] = [{ type: 'text', text: `${who} turn ${turn}` }];
        if (who === 'root-a' && turn === 0) content = [
          { type: 'toolCall', id: 'a-task', name: 'TaskCreate', arguments: { title: 'held task' } },
          { type: 'toolCall', id: 'a-agent', name: 'Agent', arguments: { prompt: 'CHILD-A do the child step', description: 'child step', subagent_type: 'general', model: 'inherit', max_turns: 2 } },
          { type: 'toolCall', id: 'a-bash', name: 'bash', arguments: { command: gated('root-a') } },
        ];
        else if (who === 'root-a' && turn === 1) content = [{ type: 'toolCall', id: 'a-list', name: 'TaskList', arguments: {} }];
        else if (who === 'child-a' && turn === 0) content = [{ type: 'toolCall', id: 'c-bash', name: 'bash', arguments: { command: gated('child-a') } }];
        else if (who === 'root-b' && turn === 0) content = [{ type: 'toolCall', id: 'b-bash', name: 'bash', arguments: { command: gated('root-b') } }];
        queueMicrotask(() => stream.push({ type: 'done', reason: content[0]!.type === 'toolCall' ? 'toolUse' : 'stop', message: assistant(content) }));
        return stream;
      } });
    return models;
  };
  return { calls, createModelRuntime };
}

export async function harness(names: readonly string[]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hold-runs-')));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'workspace'); await mkdir(cwd);
  const directory = join(root, 'daemon'); await mkdir(directory, { mode: 0o700 });
  const target = { kind: 'isolated' as const, directory, namespaceId: randomUUID() };
  const owner = await acquireDaemonOwnership(target);
  const hostConfigPath = join(owner.target.agentDir, 'host.json');
  try {
    const config = JSON.parse(await readFile(new URL('../../src/host.json', import.meta.url), 'utf8'));
    config.extensions = ['ext-background-bash', 'ext-subagents', 'ext-tasks'].map(name => ({ package: `@felan-ai/${name}` }));
    await writeFile(hostConfigPath, JSON.stringify(config), { mode: 0o600 });
  } finally { await owner.release(); }
  const model = scriptedModel();
  const start = () => startDaemonService(target, { hostConfigPath, drainTimeoutMs: WAIT_MS, createModelRuntime: model.createModelRuntime,
    manager: { packageName: '@felan-ai/felan', version: FELAN_VERSION, resolveFrom: import.meta.url,
      resolveProvider: specifier => specifier === '@felan-ai/ext-memory/daemon' ? import.meta.resolve(specifier)
        : new URL(`../../src/providers/${specifier.split('/').at(-1)}.ts`, import.meta.url).href } });
  const state = { service: await start() };
  cleanups.push(async () => {
    for (const name of names) await writeFile(join(cwd, `${name}.go`), '').catch(() => {});
    if (state.service.lifecycle.state !== 'stopped') { await state.service.requestStop('stop', 'force'); await state.service.stopped; }
  });
  const connect = async () => {
    const client = new SessionClient({ target, clientVersion: FELAN_VERSION, kind: 'tui' });
    cleanups.push(async () => client.close());
    await client.connect(); return client;
  };
  const store = () => state.service.registry.options.store;
  const log = async () => (await readFile(join(cwd, 'calls.log'), 'utf8').catch(() => '')).split('\n').filter(Boolean).sort();
  /** Holds a restart while every run is in its gated command, opens the gates, and returns the hold response. */
  const hold = async (client: SessionClient) => {
    const response = client.control('host.restart', 'hold');
    await vi.waitFor(() => expect(state.service.lifecycle.state).toBe('draining'), { timeout: WAIT_MS });
    for (const name of names) await writeFile(join(cwd, `${name}.go`), '');
    return response;
  };
  const stop = async () => { await state.service.requestStop('restart', 'drain'); await state.service.stopped; };
  const restart = async () => { await stop(); state.service = await start(); };
  return { cwd, model, state, store, log, connect, hold, stop, restart, start: async () => { state.service = await start(); } };
}

export async function session(client: SessionClient, cwd: string, prompt: string): Promise<string> {
  const created = await client.request('sessions.create', { cwd, model: { provider: offlineModel.provider, id: offlineModel.id } });
  if (created.outcome !== 'accepted') throw new Error(`Session creation failed: ${JSON.stringify(created)}`);
  await client.attach(created.result.sessionId);
  expect(await client.request('prompt', { text: prompt }, { session: created.result.sessionId })).toMatchObject({ outcome: 'accepted' });
  return created.result.sessionId;
}

