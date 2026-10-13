import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import type { ModelRuntime } from '@felan-ai/agent-core';
import { JsonLineDecoder, SetupPromptSchema, encodeFrame, parseSchema, type SetupPrompt } from '@felan-ai/session-protocol';
import { createLocalModelRuntime } from '../local-model-runtime.js';
import { createDaemonSettingsManager } from '../global-settings.js';
import { parseAuthWorkerInput, parseAuthWorkerOutput, type AuthWorkerInput, type AuthWorkerOutput } from './auth-wire.js';
import { guardAuthenticationParent } from './parent-guard.js';

type Start = Extract<AuthWorkerInput, { kind: 'start' }>;
export async function authenticateProvider(start: Start, io: {
  signal: AbortSignal;
  prompt(value: SetupPrompt, signal: AbortSignal): Promise<string>;
  emit(value: AuthWorkerOutput): void;
  createModels?: (agentDir: string) => Promise<ModelRuntime>;
}): Promise<void> {
  const secrets = new Set<string>(); let remaining = 128;
  const message = (value: string) => {
    if (Buffer.byteLength(value) > 64 * 1024) throw new Error('Authentication message exceeds its bound.');
    let text = stripVTControlCharacters(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, '');
    for (const secret of secrets) if (secret) text = text.split(secret).join('[REDACTED]');
    return boundedText(text, 8192);
  };
  const emit = (value: AuthWorkerOutput) => {
    io.signal.throwIfAborted();
    if (--remaining < 0) throw new Error('Provider authentication exceeded its interaction limit.');
    io.emit(parseAuthWorkerOutput(value));
  };
  const link = (label: string, value: string) => {
    if (Buffer.byteLength(value) > 4096 || /[\u0000-\u0020\u007f]/u.test(value)) return;
    let url: URL;
    try { url = new URL(value); } catch { return; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
    if ([...secrets].some(secret => secret && (value.includes(secret) || value.includes(encodeURIComponent(secret))))) return;
    for (const key of url.searchParams.keys()) if (/^(?:access_token|refresh_token|api_key|client_secret|password|token)$/iu.test(key)) url.searchParams.set(key, '[REDACTED]');
    if (/(?:access_token|refresh_token|client_secret|password|token)=/iu.test(url.hash)) url.hash = '#[REDACTED]';
    emit({ kind: 'link', label: boundedText(message(label), 4096), url: url.toString() });
  };
  try {
    io.signal.throwIfAborted();
    const models = await (io.createModels ?? createLocalModelRuntime)(start.agentDir);
    io.signal.throwIfAborted();
    const interaction: Parameters<ModelRuntime['login']>[2] = {
      signal: io.signal,
      prompt: async request => {
        io.signal.throwIfAborted();
        const id = randomUUID();
        const prompt = parseSchema(SetupPromptSchema, request.type === 'select'
          ? { id, kind: 'select', message: message(request.message), choices: request.options.map(option => ({ id: option.id, label: boundedText(message(option.label), 4096),
            ...(option.description ? { description: boundedText(message(option.description), 4096) } : {}) })) }
          : { id, kind: 'input', message: message(request.message), secret: start.method === 'api_key' || request.type === 'secret' || request.type === 'manual_code',
            ...(request.placeholder ? { placeholder: boundedText(message(request.placeholder), 4096) } : {}) });
        emit({ kind: 'prompt', prompt });
        const signal = request.signal ? AbortSignal.any([io.signal, request.signal]) : io.signal;
        let answer: string;
        try { answer = await io.prompt(prompt, signal); }
        finally { if (!io.signal.aborted) emit({ kind: 'dismiss', promptId: id }); }
        io.signal.throwIfAborted();
        if (Buffer.byteLength(answer) > 64 * 1024) throw new Error('Authentication answer exceeds its bound.');
        if (prompt.kind === 'select' && !prompt.choices.some(choice => choice.id === answer)) throw new Error('Invalid authentication choice.');
        if (prompt.kind === 'input' && answer) secrets.add(answer);
        return answer;
      },
      notify: event => {
        if (event.type === 'auth_url') {
          if (event.instructions) emit({ kind: 'info', message: message(event.instructions) });
          link('Open this URL to continue', event.url);
        } else if (event.type === 'device_code') {
          link('Open this URL to continue', event.verificationUri);
          emit({ kind: 'info', message: `Device code: ${message(event.userCode)}` });
          if (event.userCode) secrets.add(event.userCode);
        } else {
          emit({ kind: 'info', message: message(event.message) });
          if (event.type === 'info') for (const value of (event.links ?? []).slice(0, 16)) link(value.label ?? 'More information', value.url);
        }
      },
    };
    if (start.provider === 'openai' && start.method === 'oauth') {
      const settings = createDaemonSettingsManager(start.agentDir, start.agentDir); const deviceId = settings.getOrCreateDeviceId();
      await settings.flush(); if (settings.drainErrors().length) throw new Error('Could not save the installation device ID.');
      await models.login(start.provider, start.method, interaction, { getDeviceId: () => deviceId });
    } else await models.login(start.provider, start.method, interaction);
    io.signal.throwIfAborted(); emit({ kind: 'done' });
  } finally { secrets.clear(); }
}

function runWorker(): void {
  const guard = guardAuthenticationParent();
  guard.on('error', () => process.exit(1));
  const control = new AbortController(); const decoder = new JsonLineDecoder();
  let started = false; let waiting: { id: string; resolve(value: string): void; reject(error: unknown): void } | undefined;
  const end = (code: number) => { control.abort(); waiting?.reject(new Error('Authentication ended.')); process.exit(code); };
  const emit = (value: AuthWorkerOutput) => process.stdout.write(encodeFrame(parseAuthWorkerOutput(value)));
  process.stdin.on('end', () => end(1)); process.stdin.on('error', () => end(1));
  process.once('SIGTERM', () => end(1)); process.once('SIGINT', () => end(1));
  process.stdin.on('data', (bytes: Buffer) => {
    try {
      for (const frame of decoder.push(bytes)) {
        const value = parseAuthWorkerInput(frame);
        if (value.kind === 'cancel') { end(1); return; }
        if (value.kind === 'start') {
          if (started) throw new Error('Authentication already started.'); started = true;
          void authenticateProvider(value, { signal: control.signal, emit,
            prompt: (prompt, signal) => new Promise<string>((resolve, reject) => {
              if (waiting) throw new Error('Authentication prompt overlap.');
              const abort = () => { if (waiting?.id === prompt.id) waiting = undefined; reject(new Error('Authentication prompt cancelled.')); };
              const finish = (text: string) => { signal.removeEventListener('abort', abort); resolve(text); };
              waiting = { id: prompt.id, resolve: finish, reject: error => { signal.removeEventListener('abort', abort); reject(error); } };
              signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
            }),
          }).then(() => process.stdout.end(() => end(0)),
            () => process.stdout.write(encodeFrame({ kind: 'failed' }), () => end(1)));
        } else {
          if (!waiting || waiting.id !== value.promptId) throw new Error('No matching authentication prompt.');
          const pending = waiting; waiting = undefined; pending.resolve(value.text);
        }
      }
    } catch { end(1); }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runWorker();

function boundedText(value: string, bytes: number): string {
  if (Buffer.byteLength(value) <= bytes) return value;
  let result = ''; let size = 0;
  for (const point of value) { size += Buffer.byteLength(point); if (size > bytes) break; result += point; }
  return result;
}
