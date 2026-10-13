import { fileURLToPath } from 'node:url';
import type { AgentRuntime } from '@felan-ai/agent-core';
import { JsonLineDecoder, encodeFrame } from '@felan-ai/session-protocol';
import { parseAuthWorkerInput, parseAuthWorkerOutput, type AuthWorkerInput, type AuthWorkerOutput } from './auth-wire.js';

export class AuthCleanupError extends Error { readonly code = 'auth_cleanup_failed'; }

export async function startAuthWorker(runtime: AgentRuntime, start: Extract<AuthWorkerInput, { kind: 'start' }>, options: {
  signal: AbortSignal;
  event(value: AuthWorkerOutput): void;
  entrypoint?: string;
}): Promise<{ done: Promise<void>; answer(promptId: string, text: string): Promise<void> }> {
  if (!runtime.processes?.startStdio) throw new Error('Provider sign-in requires a local stdio process runtime.');
  options.signal.throwIfAborted();
  const worker = await runtime.processes.startStdio(process.execPath, [options.entrypoint ?? fileURLToPath(new URL('./auth-worker.js', import.meta.url))], { cwd: runtime.cwd });
  let prompt: string | undefined; let termination: Promise<void> | undefined;
  const abort = () => {
    termination ??= (async () => { await worker.terminate('SIGKILL'); })();
    void termination.catch(() => {});
  };
  options.signal.addEventListener('abort', abort, { once: true }); if (options.signal.aborted) abort();
  const done = (async () => {
    const decoder = new JsonLineDecoder(); let offset = 0; let bytes = 0; let complete = false;
    try {
      options.signal.throwIfAborted(); await worker.write(encodeFrame(parseAuthWorkerInput(start)));
      for (;;) {
        options.signal.throwIfAborted();
        const next = await worker.readStdout(offset, { waitMs: 250, maxBytes: 64 * 1024, signal: options.signal });
        options.signal.throwIfAborted();
        if (next.nextOffset !== offset + next.output.byteLength) throw new Error('Authentication output was lost.');
        offset = next.nextOffset; bytes += next.output.byteLength;
        if (bytes > 2 * 1024 * 1024) throw new Error('Authentication output limit exceeded.');
        for (const frame of decoder.push(next.output)) {
          if (complete) throw new Error('Unexpected authentication event after completion.');
          const event = parseAuthWorkerOutput(frame);
          if (event.kind === 'failed') throw new Error('Provider sign-in failed.');
          if (event.kind === 'prompt') prompt = event.prompt.id;
          if (event.kind === 'dismiss' && prompt === event.promptId) prompt = undefined;
          if (event.kind === 'done') complete = true;
          options.event(event);
        }
        if (!next.running && next.output.byteLength === 0) {
          decoder.finish();
          if (!complete || next.exitCode !== 0) throw new Error('Provider sign-in did not complete.');
          return;
        }
      }
    } finally {
      const failures: unknown[] = [];
      try { await worker.dispose(); }
      catch (error) { failures.push(error); }
      finally { options.signal.removeEventListener('abort', abort); }
      try { await termination; }
      catch (error) { failures.push(error); }
      if (failures.length) throw new AuthCleanupError('Authentication process cleanup failed.', {
        cause: failures.length === 1 ? failures[0] : new AggregateError(failures, 'Authentication cleanup operations failed.'),
      });
    }
  })();
  return { done, async answer(promptId, text) {
    options.signal.throwIfAborted();
    if (prompt !== promptId) throw new Error('Authentication prompt is no longer active.');
    prompt = undefined;
    await worker.write(encodeFrame(parseAuthWorkerInput({ kind: 'answer', promptId, text })));
  } };
}
