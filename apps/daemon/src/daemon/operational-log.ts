import { createHash } from 'node:crypto';
import { PageRequestSchema, parseSchema, type OperationParams, type OperationResult } from '@felan-ai/session-protocol';
import { commandError } from './commands.js';
import { BoundedDaemonLogs } from './supervisor.js';

const messages = {
  started: 'Daemon is ready.',
  stop_requested: 'Explicit daemon stop requested.',
  restart_requested: 'Explicit daemon restart requested.',
  drain_blocked: 'Daemon shutdown is blocked; ownership remains held.',
  releasing: 'Owned work settled; releasing daemon ownership.',
  ownership_lost: 'Daemon ownership was lost; admission is fenced.',
  startup_failed: 'Daemon startup could not complete.',
} as const;
type Entry = OperationResult<'host.logs'>['entries'][number];

export class DaemonOperationalLog {
  constructor(private readonly sink: BoundedDaemonLogs, private readonly now: () => number = Date.now) {}

  record(event: keyof typeof messages): void {
    if (!Object.hasOwn(messages, event)) throw new Error('Unknown operational event.');
    const entry: Entry = { timestamp: this.now(), level: ['drain_blocked', 'ownership_lost', 'startup_failed'].includes(event) ? 'error' : 'info', message: messages[event] };
    this.sink.write('stdout', JSON.stringify(entry));
  }

  page(input: OperationParams<'host.logs'>): OperationResult<'host.logs'> {
    const params = parseSchema(PageRequestSchema, input);
    const known = new Set<string>(Object.values(messages));
    const entries: Entry[] = [];
    for (const line of this.sink.read('stdout').split('\n')) {
      let value: unknown; try { value = JSON.parse(line); } catch { continue; }
      if (value === null || typeof value !== 'object') continue;
      const row = value as Partial<Entry>;
      if (!Number.isSafeInteger(row.timestamp) || row.timestamp! < 0 || !['info', 'warning', 'error'].includes(row.level ?? '') || !known.has(row.message ?? '')) continue;
      entries.push({ timestamp: row.timestamp!, level: row.level!, message: row.message! });
    }
    const generation = createHash('sha256').update(JSON.stringify(entries)).digest('hex');
    let offset = 0;
    if (params.cursor) {
      const match = /^([a-f0-9]{64}):(\d{1,6})$/.exec(params.cursor);
      if (!match || match[1] !== generation || Number(match[2]) > entries.length) throw commandError('resync_required');
      offset = Number(match[2]);
    }
    const result = entries.slice(offset, offset + (params.limit ?? 64));
    const next = offset + result.length;
    return { entries: result, ...(next < entries.length ? { cursor: `${generation}:${next}` } : {}) };
  }
}
