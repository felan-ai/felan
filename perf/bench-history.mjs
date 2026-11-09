import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { built } from './lib.mjs';
import { generator } from './fixtures.mjs';

const PAGE = 64;

function corpus(directory, sessions, entries) {
  const random = generator();
  const phrases = ['plain ASCII text ', '中文测试数据 ', 'emoji 🐈 🚀 ✨ ', 'combining e\u0301 and café ', 'line one\nline two\t'];
  const text = () => Array.from({ length: 16 }, () => phrases[Math.floor(random() * phrases.length)]).join('');
  const rows = [];
  for (let s = 0; s < sessions; s++) {
    const id = `perf-session-${s}`;
    const started = Date.UTC(2026, 0, 1) + s * 60_000;
    const lines = [JSON.stringify({ type: 'session', version: 3, id, cwd: '/tmp/perf-project', timestamp: new Date(started).toISOString() })];
    for (let e = 0; e < entries; e++) {
      lines.push(JSON.stringify({ type: 'message', id: `${id}-e${e}`, parentId: e ? `${id}-e${e - 1}` : null, timestamp: new Date(started + e).toISOString(),
        message: { role: e % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: text() }], timestamp: started + e } }));
    }
    const key = join(directory, `${id}.jsonl`);
    writeFileSync(key, lines.join('\n') + '\n');
    rows.push({ key, id, cwd: '/tmp/perf-project', title: `Session ${s}`, updatedAt: started, state: 'closed' });
  }
  return rows;
}

/** Mirrors the registry history provider: one stat per listed file and a bounded, stat-checked read. */
function registryLike(rows) {
  const counts = { inventories: 0, stats: 0, reads: 0 };
  const row = async stored => {
    counts.stats++;
    let bytes, diagnostic, updatedAt = stored.updatedAt;
    try {
      const info = await stat(stored.key);
      if (!info.isFile()) diagnostic = 'inaccessible';
      else { bytes = info.size; updatedAt = Math.max(updatedAt, Math.floor(info.mtimeMs)); }
    } catch { diagnostic = 'inaccessible'; }
    return { key: stored.key, sessionId: stored.id, id: stored.id, root: stored.id, cwd: stored.cwd, title: stored.title, updatedAt, state: stored.state,
      ...(bytes === undefined ? {} : { bytes }), ...(diagnostic ? { diagnostic } : {}) };
  };
  const generation = JSON.stringify(rows.map(stored => [stored.id, stored.key]));
  return {
    counts,
    generation: () => generation,
    inventory: async () => {
      counts.inventories++;
      const sources = [];
      for (const stored of rows) sources.push(await row(stored));
      return sources;
    },
    refresh: async source => {
      const stored = rows.find(item => item.key === source.key);
      return stored && row(stored);
    },
    read: async (source, { maxBytes }) => {
      counts.reads++;
      const file = await open(source.key, 'r');
      try {
        const before = await file.stat({ bigint: true });
        if (before.size > BigInt(maxBytes)) throw new Error('oversize');
        const buffer = Buffer.alloc(Number(before.size) + 1);
        let offset = 0;
        while (offset < buffer.length) {
          const { bytesRead } = await file.read(buffer, offset, Math.min(65_536, buffer.length - offset), offset);
          if (!bytesRead) break;
          offset += bytesRead;
        }
        const after = await file.stat({ bigint: true });
        if (offset !== Number(before.size) || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs) throw new Error('stale');
        return buffer.subarray(0, offset);
      } finally { await file.close(); }
    },
  };
}

export async function run(ctx) {
  const { createSessionHistoryBackend } = await built('apps/daemon/dist/session-history.js');
  const sessions = ctx.quick ? 100 : 400;
  const entries = 200;
  const directory = mkdtempSync(join(tmpdir(), 'history-'));
  try {
    const rows = corpus(directory, sessions, entries);
    const provider = registryLike(rows);
    const backend = createSessionHistoryBackend({ current: { id: 'perf-current', root: 'perf-current' }, project: '/tmp/perf-project', ...provider });
    const details = { sessions, entries, pageEntries: PAGE };
    const timed = async (name, work) => {
      const before = { ...provider.counts };
      const start = performance.now();
      await work();
      ctx.value(name, performance.now() - start, 'ms', { ...details,
        ...Object.fromEntries(Object.entries(provider.counts).map(([key, value]) => [key, value - before[key]])) });
    };
    let listed = [];
    await ctx.case('history.list', () => timed('history.list.all-pages', async () => {
      let cursor;
      do {
        const page = await backend.list({ scope: 'visible' }, { limit: PAGE, ...(cursor ? { cursor } : {}) });
        listed.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);
      if (listed.length !== sessions) throw new Error(`Listed ${listed.length} of ${sessions} sessions`);
    }));
    await ctx.case('history.checkpoint', () => timed('history.checkpoint.all', async () => {
      for (const info of listed) await backend.checkpoint(info.id);
    }));
    await ctx.case('history.pages', () => timed('history.pages.all', async () => {
      for (const info of listed) {
        let cursor, count = 0;
        do {
          const page = await backend.history(info.id, { limit: PAGE, ...(cursor ? { cursor } : {}) });
          count += page.entries.length;
          cursor = page.nextCursor;
        } while (cursor);
        if (count !== entries) throw new Error(`Read ${count} of ${entries} entries`);
      }
    }));
    await ctx.case('history.insights', () => timed('history.checkpoint-then-pages.each', async () => {
      for (const info of listed) {
        await backend.checkpoint(info.id);
        let cursor;
        do { cursor = (await backend.history(info.id, { limit: PAGE, ...(cursor ? { cursor } : {}) })).nextCursor; } while (cursor);
      }
    }));
    for (const [name, value] of Object.entries(provider.counts)) ctx.value(`history.total.${name}`, value, 'calls', details);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
