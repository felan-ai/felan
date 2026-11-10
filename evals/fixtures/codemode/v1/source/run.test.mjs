import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadComposition, runScenario } from './run.mjs';

const composition = await loadComposition(
  fileURLToPath(new URL('../../../../../packages/agent-core/dist/index.js', import.meta.url)),
  fileURLToPath(new URL('../../../../../apps/felan/dist/index.js', import.meta.url)),
);
const core = composition.core;
const catalog = await core.ModelRuntime.create({ credentials: new core.InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
const model = catalog.getModel('openai-codex', 'gpt-6.1-sol');
assert.ok(model);

function offlineModels(respond) {
  const calls = [];
  return { calls,
    async createModelRuntime() {
      const models = await core.ModelRuntime.create({ credentials: new core.InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
      models.registerProvider(model.provider, { api: model.api, baseUrl: 'https://offline.invalid',
        apiKey: 'offline-codemode-fixture', models: [model],
        streamSimple: () => { throw new Error('Provider inference is forbidden in offline fixture tests'); },
      });
      models.streamSimple = (active, context) => {
        calls.push({ active, context });
        const content = respond(active, context, calls.length);
        const stopReason = content.some(part => part.type === 'toolCall') ? 'toolUse' : 'stop';
        const message = { role: 'assistant', content, api: active.api, provider: active.provider, model: active.id,
          timestamp: Date.now(), stopReason, usage: { input: 4, output: 2, cacheRead: 1, cacheWrite: 0, totalTokens: 7,
            cost: { input: 0.004, output: 0.002, cacheRead: 0.001, cacheWrite: 0, total: 0.007 } },
        };
        const stream = core.createAssistantMessageEventStream();
        queueMicrotask(() => stream.push({ type: 'done', reason: stopReason, message }));
        return stream;
      };
      return models;
    },
  };
}

async function fixture(t, mode, respond, id = 'listening-summary') {
  const events = [];
  t.mock.method(console, 'log', line => events.push(JSON.parse(line)));
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Network access is forbidden in offline fixture tests'); });
  const root = await mkdtemp(join(tmpdir(), 'cm-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const models = offlineModels(respond);
  const agentDir = join(root, 'agent');
  const options = { composition, createModelRuntime: models.createModelRuntime, model, mode, thinking: 'off',
    id, cwd: join(root, 'workspace'), agentDir };
  return { root, agentDir, models, events, options, run: () => runScenario(options) };
}

const text = value => [{ type: 'text', text: JSON.stringify(value) }];
const call = (name, args = {}, id = name) => ({ type: 'toolCall', id, name, arguments: args });
const toolResults = context => context.messages.filter(message => message.role === 'toolResult');
function output(message) {
  const parts = message.content.filter(part => part.type === 'text').map(part => part.text);
  return JSON.parse(message.toolName === 'codemode' ? parts.at(-1) : parts.join('\n'));
}

function listeningSummary(events, tracks, albums) {
  const totals = new Map();
  for (const event of new Map(events.map(entry => [entry.eventId, entry])).values()) {
    if (event.type !== 'played' || event.playedSeconds < 30) continue;
    const albumId = tracks.find(track => track.trackId === event.trackId).albumId;
    const total = totals.get(albumId) ?? { playCount: 0, playedSeconds: 0 };
    total.playCount += 1;
    total.playedSeconds += event.playedSeconds;
    totals.set(albumId, total);
  }
  return { albums: [...totals].map(([albumId, total]) => {
    const { title, artist } = albums.find(album => album.albumId === albumId);
    return { albumId, title, artist, ...total };
  }).sort((left, right) => right.playedSeconds - left.playedSeconds || left.albumId.localeCompare(right.albumId)) };
}

function migrate(config) {
  return { ...config, version: 2, services: config.services.map(({ timeoutMs, retries, ...service }) => ({
    ...service, transport: { timeoutMs, retry: { maxAttempts: retries + 1, backoffMs: 100 } },
  })) };
}

for (const mode of ['off', 'on', 'only']) {
  test(`fixture uses shipped code-mode config ${mode}`, async (t) => {
    const f = await fixture(t, mode, () => text({}));
    const result = await f.run();
    const declarations = f.models.calls.map(({ context }) => core.getCurrentTools(context.messages).map(tool => tool.name));
    assert.equal(result.executionError, false, JSON.stringify(result.messages.at(-1)));
    assert.equal(result.providerError, false, JSON.stringify(result.messages.at(-1)));
    assert.equal(result.mode, mode);
    assert.equal(JSON.parse(await readFile(join(f.agentDir, 'settings.json'), 'utf8')).codemode.mode, mode);
    assert.equal(declarations.length, 1);
    assert.equal(declarations[0].includes('codemode'), mode !== 'off');
    if (mode === 'only') assert.deepEqual(declarations[0], ['codemode']);
    else assert.ok(declarations[0].length > 1);
    assert.equal(result.grade.passed, false);
    assert.deepEqual(result.grade.checks, [{ name: 'json-only', passed: true }, { name: 'exact-result', passed: false }]);
    assert.equal(result.arm, mode === 'off' ? 'direct' : mode);
    assert.equal(result.provider, model.provider);
    assert.equal(result.model, model.id);
    assert.equal(result.thinking, 'off');
    assert.equal(result.piVersion, composition.piVersion);
    const files = await readdir(join(f.agentDir, 'sessions'), { recursive: true });
    const transcript = files.filter(file => file.endsWith('.jsonl'));
    assert.equal(transcript.length, 1);
    const entries = (await readFile(join(f.agentDir, 'sessions', transcript[0]), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(entries[0].type, 'session');
    assert.ok((await stat(join(f.agentDir, 'storage', 'sessions', entries[0].id))).isDirectory());
    assert.deepEqual(entries.filter(entry => entry.type === 'message').map(entry => entry.message), result.messages);
    assert.deepEqual(f.events.filter(event => event.type === 'message_end').map(event => event.message), result.messages);
    assert.equal(result.messages.at(-1).usage.totalTokens, 7);
    assert.equal(result.messages.at(-1).usage.cost.total, 0.007);
  });

  test(`fixture executes and grades synthetic APIs in ${mode} mode`, async (t) => {
    const names = ['playback_events', 'music_tracks', 'music_albums'];
    const f = await fixture(t, mode, (_active, context, turn) => {
      if (turn === 1) return mode === 'off' ? names.map(name => call(name)) : [call('codemode', { code: `
        const [playback, tracks, albums] = await Promise.all([
          tools.playback_events({}), tools.music_tracks({}), tools.music_albums({})
        ]);
        return (${listeningSummary.toString()})(playback.events, tracks.tracks, albums.albums);
      ` })];
      const results = toolResults(context);
      if (mode !== 'off') return text(output(results.at(-1)));
      const values = names.map(name => output(results.find(message => message.toolName === name)));
      return text(listeningSummary(values[0].events, values[1].tracks, values[2].albums));
    });
    const result = await f.run();
    assert.equal(result.executionError, false, JSON.stringify(result.messages.at(-1)));
    assert.equal(result.providerError, false, JSON.stringify(result.messages.at(-1)));
    assert.equal(result.grade.passed, true, JSON.stringify(result.grade));
    assert.ok(result.grade.checks.every(check => check.passed));
    assert.equal(f.models.calls.length, 2);
    assert.ok(f.models.calls.every(({ active }) => active.provider === model.provider && active.id === model.id));
    const results = result.messages.filter(message => message.role === 'toolResult');
    if (mode === 'off') assert.deepEqual(results.map(message => message.toolName), names);
    else {
      assert.equal(results.length, 1);
      assert.equal(results[0].toolName, 'codemode');
      assert.equal(results[0].nestedCalls.complete, true);
      assert.deepEqual(results[0].nestedCalls.calls.map(call => call.name), names);
      assert.ok(results[0].nestedCalls.calls.every(call => call.status === 'ok'));
    }
    assert.ok(f.events.some(event => event.type === 'tool_execution_start'));
    assert.ok(f.events.some(event => event.type === 'tool_execution_end'));
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  });

  test(`fixture preserves the migration and inventory grades in ${mode} mode`, async (t) => {
    const path = 'service-config.json';
    const f = await fixture(t, mode, (_active, context, turn) => {
      if (turn === 1) return mode === 'off' ? [call('read', { path })] : [call('codemode', { code: `
        const config = (${migrate.toString()})(JSON.parse(await tools.read({ path: '${path}' })));
        await tools.write({ path: '${path}', content: JSON.stringify(config, null, 2) + '\\n' });
        return { migrated: config.services.length, version: config.version };
      ` })];
      if (mode !== 'off') return text(output(toolResults(context).at(-1)));
      if (turn === 2) return [call('write', { path, content: `${JSON.stringify(migrate(output(toolResults(context).at(-1))), null, 2)}\n` })];
      return text({ migrated: 3, version: 2 });
    }, 'structured-migration');
    const result = await f.run();
    assert.equal(result.executionError, false, JSON.stringify(result.messages.at(-1)));
    assert.equal(result.providerError, false, JSON.stringify(result.messages.at(-1)));
    assert.equal(result.grade.passed, true, JSON.stringify(result.grade));
    assert.ok(result.grade.checks.every(check => check.passed));
  });
}

test('fixture rejects missing runtime injection and providers outside the fixed installation', async (t) => {
  const f = await fixture(t, 'off', () => text({}));
  await assert.rejects(runScenario({ ...f.options, createModelRuntime: undefined }), /explicit benchmark model runtime factory/);
  assert.throws(() => composition.manager.resolveProvider('ambient-provider'), /outside the benchmark installation/);
});

test('fixture fails before inference if shipped code mode was not activated', async (t) => {
  const f = await fixture(t, 'on', () => { assert.fail('Model inference must not start'); });
  const changed = { ...composition, sessionRuntime: { ...composition.sessionRuntime,
    createLocalSessionRuntime(options) {
      const runtime = composition.sessionRuntime.createLocalSessionRuntime(options);
      return { ...runtime, async prepare(request) {
        const prepared = await runtime.prepare(request);
        return { ...prepared, options: { ...prepared.options, inlineExtensions: [] } };
      } };
    },
  } };
  await assert.rejects(runScenario({ ...f.options, composition: changed }), /did not activate the expected code mode/);
  assert.equal(f.models.calls.length, 0);
});
