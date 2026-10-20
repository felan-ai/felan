import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { built } from './lib.mjs';
import { catalog, snapshot } from './fixtures.mjs';

export const SQLITE_CASES = [
  ['FULL-fullfsync', 'PRAGMA synchronous=FULL; PRAGMA fullfsync=ON; PRAGMA checkpoint_fullfsync=ON'],
  ['FULL', 'PRAGMA synchronous=FULL; PRAGMA fullfsync=OFF; PRAGMA checkpoint_fullfsync=OFF'],
  ['NORMAL', 'PRAGMA synchronous=NORMAL; PRAGMA fullfsync=OFF; PRAGMA checkpoint_fullfsync=OFF'],
  ['shipped', 'PRAGMA synchronous=NORMAL; PRAGMA fullfsync=ON; PRAGMA checkpoint_fullfsync=ON'],
].map(([label, pragma]) => [label, `PRAGMA journal_mode=WAL; ${pragma}; PRAGMA busy_timeout=1000`]);

export async function run(ctx) {
  await ctx.case('sqlite', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const warmup = ctx.quick ? 10 : 100;
    const measured = ctx.quick ? 40 : 1000;
    for (const [label, pragma] of SQLITE_CASES) await ctx.case(`sqlite.${label}`, async () => {
      const db = new DatabaseSync(join(process.env.HOME, `${label}.sqlite`));
      try {
        db.exec(`${pragma}; CREATE TABLE requests (id TEXT PRIMARY KEY, ord INTEGER NOT NULL, data TEXT NOT NULL) STRICT`);
        const upsert = db.prepare('INSERT INTO requests VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET ord = excluded.ord, data = excluded.data');
        const data = JSON.stringify({ phase: 'intent', identity: { sha256: 'a'.repeat(64), bytes: 300 }, admittedAt: 1700000000000 });
        const details = { warmup, pragmas: pragma, sqliteVersion: db.prepare('SELECT sqlite_version() AS version').get().version,
          walAutocheckpoint: db.prepare('PRAGMA wal_autocheckpoint').get().wal_autocheckpoint };
        const values = []; const commits = [];
        for (let i = 0; i < warmup + measured; i++) {
          const start = performance.now();
          db.exec('BEGIN IMMEDIATE'); upsert.run(`request-${i % 20}`, i, data);
          const commitStart = performance.now(); db.exec('COMMIT');
          const end = performance.now();
          if (i >= warmup) { values.push(end - start); commits.push(end - commitStart); }
        }
        ctx.samples(`sqlite.${label}.transaction`, values, 'ms', details);
        ctx.samples(`sqlite.${label}.commit`, commits, 'ms', details);
      } finally { db.close(); }
    });
  });
  const P = await built('packages/session-protocol/dist/index.js');
  await ctx.case('catalog', async () => {
    const value = catalog();
    ctx.bench('catalog.parse', () => P.parseSchema(P.CatalogSchema, value));
    ctx.bench('catalog.digest', () => createHash('sha256').update(JSON.stringify(value)).digest('hex'));
  });
  await ctx.case('delta-accounting-reference', async () => {
    for (const total of [16000, 200000]) {
      const chunk = 'token 中文🐈 ';
      ctx.bench(`accounting.${total}.remeasure-reference`, () => {
        let prefix = '';
        for (let i = 0; i < total; i += chunk.length) { prefix += chunk; Buffer.byteLength(prefix); }
      }, { iterations: ctx.quick ? 2 : 10 });
      ctx.bench(`accounting.${total}.incremental-reference`, () => {
        let bytes = 0;
        for (let i = 0; i < total; i += chunk.length) bytes += Buffer.byteLength(chunk);
        return bytes;
      }, { iterations: ctx.quick ? 2 : 10 });
    }
  });
  await ctx.case('snapshot-capture-primitives', async () => {
    const snap = snapshot({ large: true });
    ctx.bench('capture.validate', () => P.parseSessionSnapshot(snap));
    ctx.bench('capture.encode-attach', () => P.encodeFrame({ v: 1, re: 'req', outcome: 'accepted', result: { attachmentId: 'a', snapshot: snap } }));
    ctx.bench('capture.history-page-budget', () => snap.history.entries.reduce((bytes, message) => bytes + Buffer.byteLength(JSON.stringify(message)), 0));
    const saved = { id: snap.session, root: snap.root, revision: snap.revision, state: snap.state, residency: snap.residency, run: snap.run, policy: snap.policy,
      title: snap.title, branch: snap.branch, cwd: snap.cwd, model: snap.model, thinking: snap.thinking,
      projections: Array.from({ length: 256 }, (_, i) => ({ key: `message:m-${i}`, value: { type: 'message', id: `m-${i}`, entryId: `e-${i}`, state: 'observed' } })) };
    ctx.bench('control-state.clone', () => structuredClone(saved));
  });
}
