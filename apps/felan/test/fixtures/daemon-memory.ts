import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  HostAgentRuntime, InMemoryCredentialStore, ModelRuntime, createAssistantMessageEventStream,
  type AssistantMessage, type Context, type ToolCall,
} from '@felan-ai/agent-core';
import {
  LocalMemoryStore, createDefaultMemoryIndex, createSessionCheckpoint, resolveLocalMemoryProject,
  type MemoryInputManifest, type SessionCheckpoint,
} from '@felan-ai/ext-memory';
import { startDaemonService } from '../../../daemon/src/daemon/service.js';
import { createHostSessionsHistory } from '../../../daemon/src/daemon/session-services.js';
import { resolveDaemonTarget } from '../../../daemon/src/daemon/target.js';
import { FELAN_VERSION } from '../../src/version.js';

export const memoryPreference = 'Use UTC for customer-facing maintenance windows.';
const model = {
  id: 'fixture-mini', name: 'Offline memory fixture', provider: 'offline', api: 'openai-completions' as const,
  baseUrl: 'https://example.invalid', reasoning: false, input: ['text' as const], contextWindow: 32_768, maxTokens: 4_096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function message(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason']): AssistantMessage {
  return { role: 'assistant', content, stopReason, api: model.api, provider: model.provider, model: model.id,
    timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

function tool(name: string, args: ToolCall['arguments'], index: number): ToolCall {
  return { type: 'toolCall', id: `memory-${index}-${name}`, name, arguments: args };
}

function scriptedDream() {
  const entered = gate();
  const release = gate();
  const calls: Context[] = [];
  let manifest: MemoryInputManifest | undefined;
  let aborted = false;
  const createModels = async () => {
    const models = await ModelRuntime.create({ modelsPath: null, credentials: new InMemoryCredentialStore(), refreshOnCreate: false });
    models.registerProvider(model.provider, { api: model.api, baseUrl: model.baseUrl, apiKey: 'offline-fixture', models: [model],
      streamSimple: (_model, context, options) => {
        const turn = calls.length;
        calls.push(structuredClone(context));
        const stream = createAssistantMessageEventStream();
        const finish = (content: AssistantMessage['content']) => {
          const reason = content.some(item => item.type === 'toolCall') ? 'toolUse' : 'stop';
          stream.push({ type: 'done', reason, message: message(content, reason) });
        };
        queueMicrotask(() => {
          if (turn === 0) {
            finish([tool('read', { path: '.dreaming/input/manifest.json' }, 0)]);
          } else if (turn === 1) {
            const result = context.messages.find(item => item.role === 'toolResult');
            if (!result || result.role !== 'toolResult' || result.isError) throw new Error('The worker did not read its input manifest');
            manifest = JSON.parse(result.content.filter(item => item.type === 'text').map(item => item.text).join('\n'));
            finish([
              ...manifest!.sessions.map((session, index) => tool('read', { path: `.dreaming/input/${session.transcriptPath}` }, index + 1)),
              tool('read', { path: '.memory/index.md' }, 100),
              tool('read', { path: '.memory/summary.md' }, 101),
            ]);
          } else if (turn === 2) {
            finish([
              tool('write', { path: '.memory/summary.md', content: `# Project memory\n\n${memoryPreference}\n` }, 200),
              tool('write', { path: '.memory/index.md', content: createDefaultMemoryIndex('.memory').replace('- (none yet)',
                '- [Preferences](pages/preferences/index.md)') }, 201),
              tool('write', { path: '.memory/pages/preferences/index.md', content: '# Preferences\n\n- [Maintenance windows](maintenance.md)\n' }, 202),
              tool('write', { path: '.memory/pages/preferences/maintenance.md', content: `# Maintenance windows\n\n${memoryPreference}\n\n## Sources\n${manifest!.sessions.map(session => `- session:${session.checkpoint.sessionId}`).join('\n')}\n` }, 203),
            ]);
          } else if (turn === 3) {
            const signal = options?.signal;
            const abort = () => {
              aborted = true;
              signal?.removeEventListener('abort', abort);
              stream.push({ type: 'error', reason: 'aborted', error: message([], 'aborted') });
            };
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) abort();
            entered.resolve();
            void release.promise.then(() => {
              signal?.removeEventListener('abort', abort);
              if (!aborted) finish([{ type: 'text', text: 'Recorded the maintenance window preference.' }]);
            });
          } else {
            throw new Error('Unexpected extra dream turn');
          }
        });
        return stream;
      } });
    return models;
  };
  return { createModels, calls, entered: entered.promise, release: release.resolve,
    get manifest() { return manifest; }, get aborted() { return aborted; } };
}

export async function daemonMemoryFixture(root: string) {
  const cwd = join(root, 'workspace');
  const subdirectory = join(cwd, 'packages', 'app');
  const directory = join(root, 'daemon');
  const target = { kind: 'isolated' as const, directory, namespaceId: randomUUID() };
  const agentDir = resolveDaemonTarget(target).agentDir;
  const dream = scriptedDream();
  let service: Awaited<ReturnType<typeof startDaemonService>> | undefined;
  const stop = async () => {
    if (!service || service.lifecycle.state === 'stopped') return;
    await service.requestStop('stop', 'drain');
    await service.stopped;
  };
  const dispose = async () => { dream.release(); await stop(); await rm(root, { recursive: true, force: true }); };
  try {
    await mkdir(subdirectory, { recursive: true });
    await mkdir(agentDir, { recursive: true, mode: 0o700 });
    await promisify(execFile)('git', ['init', '--quiet', cwd]);
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ enabledModels: ['offline/*'] }));
    const config = JSON.parse(await readFile(new URL('../../dist/host.json', import.meta.url), 'utf8'));
    config.extensions = [];
    const hostConfigPath = join(agentDir, 'host.json');
    const services = config.services;
    config.services = services.filter((entry: { id: string }) => entry.id !== 'felan.memory.scheduler');
    await writeFile(hostConfigPath, JSON.stringify(config));
    const start = () => startDaemonService(target, { hostConfigPath, drainTimeoutMs: 5_000, createModelRuntime: dream.createModels,
      manager: { packageName: '@felan-ai/felan', version: FELAN_VERSION,
        resolveFrom: new URL('../../dist/daemon-host.js', import.meta.url).href,
        resolveProvider: specifier => import.meta.resolve(specifier) } });
    service = await start();
    const environment = {
      runtime: new HostAgentRuntime(cwd, { agentDir, pathAccess: 'host', agentStorageRoot: agentDir, sessionStorageRoot: agentDir }),
      sessions: createHostSessionsHistory(service.registry, { kind: 'all' }),
    };
    const store = new LocalMemoryStore(environment, agentDir, await resolveLocalMemoryProject(environment, cwd));
    await store.initialize();
    const checkpoints: SessionCheckpoint[] = [];
    for (let index = 0; index < 5; index++) {
      const binding = await service.registry.create({ cwd: index === 4 ? subdirectory : cwd, target: { kind: 'new' }, model });
      const manager = binding.runtime.session.sessionManager;
      manager.appendMessage({ role: 'user', content: `Remember this preference: ${memoryPreference}`, timestamp: Date.now() });
      manager.appendMessage(message([{ type: 'text', text: `Memory note (direct user request): ${memoryPreference}` }], 'stop'));
      const checkpoint = createSessionCheckpoint(manager);
      if (!checkpoint) throw new Error('The source transcript has no checkpoint');
      checkpoints.push(checkpoint);
      await service.registry.close(binding.sessionId);
      await store.recordCheckpoint(checkpoint);
    }
    const initial = await store.status();
    await stop();
    config.services = services;
    await writeFile(hostConfigPath, JSON.stringify(config));
    service = await start();
    return { service, store, checkpoints, initial, dream, subdirectory, stop, dispose };
  } catch (error) { await dispose(); throw error; }
}
