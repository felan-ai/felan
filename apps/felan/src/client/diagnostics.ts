import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Operation } from '@felan-ai/session-protocol';
import type { RecoveryCause } from './reducer.js';

export type AttachTrigger = 'attach' | 'retry' | 'recovery' | 'reconnect';
export type BlockedReason =
  | { kind: 'recovery_limit'; cause?: RecoveryCause }
  | { kind: 'attach_failed'; outcome: 'rejected' | 'indeterminate' | 'error'; code?: string; message?: string };

/** Connection and attachment transitions; never message content. */
export type ClientDiagnostic =
  | { event: 'connection.ready'; daemonVersion: string; instanceId: string }
  | { event: 'connection.failed'; error: string }
  | { event: 'connection.lost'; reason: string; error?: string }
  | { event: 'attachment.attached'; session: string; trigger: AttachTrigger; outcome: 'accepted' | 'rejected' | 'indeterminate'; durationMs: number;
    code?: string; message?: string; revision?: number; snapshotBytes?: number; counts?: Record<string, number> }
  | { event: 'attachment.recovering'; session: string; cause: RecoveryCause; attempts: number; op?: Operation }
  | { event: 'attachment.blocked'; session: string; attempts: number; reason: BlockedReason };

const causes: Record<RecoveryCause, string> = {
  revision_gap: 'missed session updates',
  stream_mismatch: 'streamed text arrived for an unexpected message',
  stream_gap: 'a gap in streamed text',
  stream_limit: 'streamed text exceeded client limits',
  presentation_conflict: 'an out-of-order presentation update',
  collection_limit: 'more than 256 tools, processes, children, interactions or presentation items',
  state_size_limit: 'session state larger than 12 MiB',
  buffer_overflow: 'too many updates arrived during recovery',
  stale_snapshot: 'the snapshot was older than updates already received',
  daemon_resync: 'the daemon asked the client to resynchronize',
};

export function describeBlocked(reason: BlockedReason | undefined): string | undefined {
  if (!reason) return undefined;
  if (reason.kind === 'recovery_limit') return `resynchronized 3 times in a row${reason.cause ? `; last cause: ${causes[reason.cause]}` : ''}`;
  const detail = [reason.code, reason.message].filter(Boolean).join(': ');
  const prefix = reason.outcome === 'rejected' ? 're-attach rejected' : reason.outcome === 'indeterminate' ? 're-attach got no answer' : 're-attach failed';
  return detail ? `${prefix}: ${detail}` : prefix;
}

export function diagnosticText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').slice(0, 500);
}

/** Appends diagnostics as JSONL in `directory/client.jsonl`, keeping one previous file once it exceeds `maxBytes`. */
export function clientDiagnosticsLog(directory: string, maxBytes = 1_048_576): { write(event: ClientDiagnostic): void; flush(): Promise<void> } {
  const path = join(directory, 'client.jsonl');
  let queue = Promise.resolve();
  return {
    write(event) {
      const line = `${JSON.stringify({ time: new Date().toISOString(), pid: process.pid, ...event })}\n`;
      queue = queue.then(async () => {
        try {
          await mkdir(directory, { recursive: true, mode: 0o700 });
          const size = await stat(path).then(info => info.size, () => 0);
          if (size > 0 && size + Buffer.byteLength(line) > maxBytes) await rename(path, join(directory, 'client.previous.jsonl'));
          await appendFile(path, line, { encoding: 'utf8', mode: 0o600 });
        } catch { /* Diagnostics never affect the client. */ }
      });
    },
    flush: () => queue,
  };
}
