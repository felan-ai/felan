import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { InMemoryCredentialStore, ModelRuntime, createAssistantMessageEventStream } from '@felan-ai/agent-core';
import { FELAN_VERSION } from '../../dist/version.js';
import { startDaemonService } from '../../../daemon/dist/daemon/service.js';

const { target, journal } = JSON.parse(process.argv[2]);
if (target.kind !== 'isolated' || journal !== `${target.directory}/provider-calls.jsonl`) throw new Error('Invalid private fixture target');
let service;
let stopping;
let parentGone = false;
let calls = 0;
const turns = new Map();

function send(value) {
  return new Promise((resolve, reject) => {
    if (!process.connected) return resolve();
    process.send(value, error => error ? reject(error) : resolve());
  });
}
function event(name, value) { void send({ event: name, value }).catch(() => {}); }

const model = { id: 'fixture', name: 'Offline process fixture', provider: 'offline', api: 'openai-completions',
  baseUrl: 'https://example.invalid', reasoning: false, input: ['text'], contextWindow: 8192, maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
function message(text, stopReason = 'stop') {
  return { role: 'assistant', content: [{ type: 'text', text }], api: model.api, provider: model.provider, model: model.id,
    timestamp: Date.now(), stopReason, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

async function createModels() {
  const models = await ModelRuntime.create({ modelsPath: null, credentials: new InMemoryCredentialStore(), refreshOnCreate: false });
  models.registerProvider('offline', { api: model.api, baseUrl: model.baseUrl, apiKey: 'synthetic-process-fixture', models: [model],
    streamSimple: (_model, _context, options) => {
      const id = `turn-${++calls}`;
      appendFileSync(journal, `${JSON.stringify({ pid: process.pid, id })}\n`, { mode: 0o600 });
      const stream = createAssistantMessageEventStream();
      let text = `FIRST:${id}`;
      let phase = 'first';
      const signal = options?.signal;
      const finish = aborted => {
        if (!turns.has(id)) return;
        turns.delete(id); signal?.removeEventListener('abort', abort);
        if (aborted) stream.push({ type: 'error', reason: 'aborted', error: message(text, 'aborted') });
        else {
          text += `\nDONE:${id}`;
          stream.push({ type: 'text_delta', contentIndex: 0, delta: `\nDONE:${id}`, partial: message(text) });
          stream.push({ type: 'text_end', contentIndex: 0, content: text, partial: message(text) });
          stream.push({ type: 'done', reason: 'stop', message: message(text) });
        }
        event('provider-finished', { id, aborted, calls });
      };
      const abort = () => finish(true);
      turns.set(id, {
        advance() {
          if (phase !== 'first') throw new Error('Provider delta already released');
          phase = 'second'; text += `\nSECOND:${id}`;
          stream.push({ type: 'text_delta', contentIndex: 0, delta: `\nSECOND:${id}`, partial: message(text) });
        },
        finish() { if (phase !== 'second') throw new Error('Release the second delta before completion'); finish(false); },
      });
      stream.push({ type: 'start', partial: message('') });
      stream.push({ type: 'text_start', contentIndex: 0, partial: message('') });
      stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: message(text) });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      event('provider-started', { id, calls, pid: process.pid });
      return stream;
    } });
  return models;
}

async function stop(mode = 'force') {
  if (mode !== 'force' && mode !== 'drain') throw new Error('Invalid stop mode');
  parentGone = true;
  if (!service) return;
  return stopping ??= (async () => {
    if (service.lifecycle.state !== 'stopped') {
      const response = await service.requestStop('stop', mode);
      if (response.outcome !== 'accepted') throw new Error(`Stop refused: ${JSON.stringify(response)}`);
      await service.stopped;
    }
  })();
}

process.on('disconnect', () => { void stop().catch(error => { console.error(error); process.exitCode = 1; }); });
process.on('SIGTERM', () => { void stop().then(() => { if (process.connected) process.disconnect(); }).catch(error => { console.error(error); process.exitCode = 1; }); });
process.on('message', command => {
  void (async () => {
    try {
      let value;
      if (command.op === 'stats') value = { calls, live: [...turns.keys()], state: service.lifecycle.state, identity: service.owner.identity };
      else if (command.op === 'advance' || command.op === 'finish') {
        const turn = turns.get(command.turn);
        if (!turn) throw new Error('Unknown live provider turn');
        turn[command.op](); value = { calls };
      } else if (command.op === 'shutdown') { await stop(command.mode ?? 'force'); value = { stopped: true }; }
      else throw new Error('Unknown daemon fixture operation');
      await send({ id: command.id, ok: true, value });
      if (command.op === 'shutdown' && process.connected) process.disconnect();
    } catch (error) { await send({ id: command.id, ok: false, error: error.message }); }
  })().catch(error => { console.error(error); process.exitCode = 1; });
});

try {
  service = await startDaemonService(target, { createModelRuntime: createModels, manager: {
    packageName: '@felan-ai/felan', version: FELAN_VERSION,
    resolveFrom: new URL('../../dist/daemon-entrypoint.js', import.meta.url).href,
    resolveProvider: specifier => import.meta.resolve(specifier),
    packagedDefaultPath: fileURLToPath(new URL('../../dist/host.json', import.meta.url)),
  } });
  if (parentGone) await stop();
  else await send({ event: 'ready', value: { pid: process.pid, identity: service.owner.identity, environment: process.env.FELAN_PROCESS_ENV } });
} catch (error) {
  console.error(error); process.exitCode = 1;
  if (process.connected) process.disconnect();
}
