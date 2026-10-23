import { afterEach, expect, it, vi } from 'vitest';
import { appendFile, chmod, link, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LegacySessionIndex, legacySessionDirectoryName, readTranscriptPreview, transcriptPreview } from '../src/daemon/legacy-sessions.js';
import { LegacySummaryCache } from '../src/daemon/legacy-summary-cache.js';
import { canonicalProspectivePath, pathInside } from '../src/daemon/target.js';

const reads = vi.hoisted(() => ({ streams: 0, active: 0, peak: 0, saves: 0, onData: undefined as (() => void) | undefined }));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, renameSync: (...args: Parameters<typeof actual.renameSync>) => {
    if (String(args[1]).endsWith('/legacy-session-summaries.json')) reads.saves++;
    return actual.renameSync(...args);
  } };
});
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args);
    const createReadStream = handle.createReadStream.bind(handle);
    handle.createReadStream = (...options: Parameters<typeof createReadStream>) => {
      reads.streams++; reads.active++; reads.peak = Math.max(reads.peak, reads.active);
      const stream = createReadStream(...options);
      stream.once('close', () => { reads.active--; });
      if (reads.onData) stream.once('data', reads.onData);
      return stream;
    };
    return handle;
  } };
});

const directories: string[] = [];
afterEach(async () => {
  reads.streams = 0; reads.active = 0; reads.peak = 0; reads.saves = 0; reads.onData = undefined;
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function stores(persistent = false) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'legacy-'))); directories.push(directory);
  const agentDir = join(directory, 'agent'); const custom = join(directory, 'custom');
  const project = join(directory, 'project'); const other = join(directory, 'other');
  const perCwd = join(agentDir, 'sessions', legacySessionDirectoryName(project));
  for (const path of [perCwd, custom, project, other]) await mkdir(path, { recursive: true, mode: 0o700 });
  const assertCurrent = vi.fn(() => {});
  const assertOwnsPath = vi.fn((path: string) => {
    assertCurrent();
    const canonical = canonicalProspectivePath(path);
    if (![agentDir, custom].some(root => pathInside(root, canonical))) throw new Error('Not owned');
    return canonical;
  });
  const owner = { target: { agentDir, rootSet: [agentDir, custom], uid: process.getuid!(), namespaceId: 'legacy-test' },
    ...(persistent ? { assertCurrent, assertOwnsPath } : {}) };
  let age = 600;
  const write = async (path: string, id: string, cwd = project, extra = '') => {
    await writeFile(path, JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-01-01T00:00:00.000Z', cwd }) + '\n' + extra, { mode: 0o600 });
    const time = new Date(Date.now() - 1000 * age--); await utimes(path, time, time);
    return path;
  };
  return { directory, agentDir, custom, project, other, perCwd, owner, write, assertCurrent,
    cachePath: join(agentDir, 'legacy-session-summaries.json'), index: new LegacySessionIndex(owner) };
}

it('discovers per-cwd and custom-directory transcripts by header cwd, newest first', async () => {
  const s = await stores();
  const perCwd = await s.write(join(s.perCwd, 'a_per-cwd.jsonl'), 'per-cwd');
  const custom = await s.write(join(s.custom, 'b_custom.jsonl'), 'custom');
  await s.write(join(s.custom, 'c_elsewhere.jsonl'), 'elsewhere', s.other);
  expect((await s.index.discover([], { cwd: s.project })).map(row => [row.id, row.path, row.cwd]))
    .toEqual([['custom', custom, s.project], ['per-cwd', perCwd, s.project]]);
  expect((await s.index.discover([])).map(row => row.id)).toEqual(['elsewhere', 'custom', 'per-cwd']);
});

it('limits explicit-directory discovery to top-level headers with the usual ID and path exclusions', async () => {
  const s = await stores(); const sessionDir = join(s.directory, 'unregistered');
  await mkdir(join(sessionDir, 'nested'), { recursive: true });
  await s.write(join(s.perCwd, 'elsewhere.jsonl'), 'elsewhere');
  await s.write(join(sessionDir, 'nested', 'nested.jsonl'), 'nested');
  const registered = await s.write(join(sessionDir, 'registered.jsonl'), 'registered-path');
  await s.write(join(sessionDir, 'registered-id.jsonl'), 'registered-id');
  await s.write(join(sessionDir, 'older.jsonl'), 'duplicate');
  const newest = await s.write(join(sessionDir, 'newer.jsonl'), 'duplicate', s.other, 'not a valid transcript body\n');
  await s.write(join(sessionDir, 'invalid-id.jsonl'), '../escape');
  await writeFile(join(sessionDir, 'invalid.jsonl'), 'not a header\n');
  const rows = await s.index.discover([{ id: 'another-id', piPath: registered }, { id: 'registered-id', piPath: '/registered.jsonl' }], { sessionDir });
  expect(rows).toEqual([{ id: 'duplicate', path: newest, cwd: s.other, modifiedAt: Math.floor((await stat(newest)).mtimeMs) }]);
  expect(reads.streams).toBe(0);
});

it('skips registered, duplicate and invalid files but lists linked transcripts and deleted cwds', async () => {
  const s = await stores();
  const registered = await s.write(join(s.perCwd, 'registered.jsonl'), 'registered');
  await s.write(join(s.perCwd, 'registered-id.jsonl'), 'registered-id');
  await s.write(join(s.perCwd, 'older-duplicate.jsonl'), 'duplicate');
  await s.write(join(s.custom, 'newer-duplicate.jsonl'), 'duplicate');
  await writeFile(join(s.perCwd, 'not-json.jsonl'), '{not json\n', { mode: 0o600 });
  await writeFile(join(s.perCwd, 'partial.jsonl'), JSON.stringify({ type: 'session', version: 3, id: 'partial', cwd: s.project }).slice(0, -4), { mode: 0o600 });
  await writeFile(join(s.perCwd, 'not-header.jsonl'), JSON.stringify({ type: 'message', id: 'entry', cwd: s.project }) + '\n', { mode: 0o600 });
  await s.write(join(s.perCwd, 'traversal.jsonl'), '../escape');
  await s.write(join(s.perCwd, 'relative-cwd.jsonl'), 'relative', 'project');
  const removed = join(s.directory, 'removed');
  await s.write(join(s.custom, 'missing-cwd.jsonl'), 'missing-cwd', removed);
  await s.write(join(s.perCwd, 'not-jsonl.json'), 'wrong-extension');
  const outside = await s.write(join(s.directory, 'outside.jsonl'), 'linked');
  await symlink(outside, join(s.perCwd, 'linked.jsonl'));
  await writeFile(join(s.perCwd, 'shared.jsonl'), JSON.stringify({ type: 'session', version: 3, id: 'shared', cwd: s.project }) + '\n', { mode: 0o644 });
  const time = new Date(Date.now() - 1_000_000); await utimes(join(s.perCwd, 'shared.jsonl'), time, time);
  const found = await s.index.discover([{ id: 'other-id', piPath: registered }, { id: 'registered-id', piPath: join(s.agentDir, 'sessions', 'x.jsonl') }]);
  expect(found.map(row => [row.id, row.path, row.cwd])).toEqual([
    ['linked', join(s.perCwd, 'linked.jsonl'), s.project],
    ['missing-cwd', join(s.custom, 'missing-cwd.jsonl'), removed],
    ['duplicate', join(s.custom, 'newer-duplicate.jsonl'), s.project],
    ['shared', join(s.perCwd, 'shared.jsonl'), s.project],
  ]);
});

it('reads the latest Pi name and the first user message from the whole transcript like Pi', async () => {
  const s = await stores();
  const entry = (row: object) => JSON.stringify(row) + '\n';
  const user = (content: unknown) => entry({ type: 'message', id: 'm', parentId: null, timestamp: 't', message: { role: 'user', content } });
  await s.write(join(s.perCwd, 'named.jsonl'), 'named', s.project,
    user('first prompt') + entry({ type: 'session_info', name: 'Old name' }) + entry({ type: 'session_info', name: '  Release plan  ' }));
  await s.write(join(s.perCwd, 'cleared.jsonl'), 'cleared', s.project, user([{ type: 'image' }]) + user([{ type: 'text', text: 'Fix\n\tthe build' }]) + entry({ type: 'session_info', name: 'Old' }) + entry({ type: 'session_info' }));
  await s.write(join(s.perCwd, 'long.jsonl'), 'long', s.project, user('x'.repeat(500)));
  await s.write(join(s.perCwd, 'empty.jsonl'), 'empty', s.project, entry({ type: 'model_change', id: 'a', parentId: null }));
  await s.write(join(s.perCwd, 'beyond.jsonl'), 'beyond', s.project, entry({ type: 'message', id: 's', parentId: null, timestamp: 't', message: { role: 'system', content: 'z'.repeat(256 * 1024) } })
    + user('after a large system prompt') + entry({ type: 'session_info', name: 'Renamed later' }));
  const found = await s.index.discover([]);
  const summaries = Object.fromEntries(await Promise.all(found.map(async row => [row.id, Object.values(await s.index.summary(row))])));
  expect(summaries).toEqual({ named: ['Release plan', 'first prompt'], cleared: ['', 'Fix the build'],
    long: ['', `${'x'.repeat(119)}…`], empty: ['', ''], beyond: ['Renamed later', 'after a large system prompt'] });
  expect(await readTranscriptPreview(join(s.perCwd, 'cleared.jsonl'))).toBe('Fix the build');
  expect(await readTranscriptPreview(join(s.perCwd, 'beyond.jsonl'))).toBe('after a large system prompt');
  expect(await readTranscriptPreview(join(s.perCwd, 'missing.jsonl'))).toBe('');
  expect(transcriptPreview([{ type: 'session_info', name: 'Named' }, { type: 'message', message: { role: 'assistant', content: 'no' } },
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'live\nprompt' }] } }])).toBe('live prompt');
});

it('lists headers without reading transcript bodies and reads a summary only on request', async () => {
  const s = await stores();
  const body = JSON.stringify({ type: 'message', id: 'm', parentId: null, timestamp: 't', message: { role: 'user', content: 'x'.repeat(64 * 1024) } }) + '\n';
  await s.write(join(s.perCwd, 'large.jsonl'), 'large', s.project, body.repeat(40));
  const [row] = await s.index.discover([]);
  expect(reads.streams).toBe(0);
  expect((await s.index.summary(row!)).preview).toBe(`${'x'.repeat(119)}…`);
  expect(reads.streams).toBe(1);
});

it('reads a transcript once for concurrent summaries and remembers it until the file changes', async () => {
  const s = await stores();
  await s.write(join(s.perCwd, 'cached.jsonl'), 'cached', s.project, JSON.stringify({ type: 'session_info', name: 'First' }) + '\n');
  const [row] = await s.index.discover([]);
  const [first, second] = await Promise.all([s.index.summary(row!), s.index.summary(row!)]);
  expect(first.title).toBe('First'); expect(second).toEqual(first); expect(reads.streams).toBe(1);
  expect((await s.index.summary(row!)).title).toBe('First'); expect(reads.streams).toBe(1);
  await appendFile(row!.path, JSON.stringify({ type: 'session_info', name: 'Second' }) + '\n');
  expect((await s.index.summary(row!)).title).toBe('Second'); expect(reads.streams).toBe(2);
});

it('follows a replaced transcript and drops a removed one', async () => {
  const s = await stores();
  const path = await s.write(join(s.perCwd, 'swap.jsonl'), 'before', s.project, JSON.stringify({ type: 'session_info', name: 'Before' }) + '\n');
  const [before] = await s.index.discover([]);
  expect(before?.id).toBe('before'); expect((await s.index.summary(before!)).title).toBe('Before');
  await rm(path); await s.write(path, 'after', s.project, JSON.stringify({ type: 'session_info', name: 'After' }) + '\n');
  expect((await s.index.discover([])).map(row => row.id)).toEqual(['after']);
  expect(await s.index.summary(before!)).toEqual({ title: '', preview: '' });
  await rm(path);
  expect(await s.index.discover([])).toEqual([]);
});

it('stops warming a listed transcript once its signal is aborted', async () => {
  const s = await stores();
  await s.write(join(s.perCwd, 'warm.jsonl'), 'warm', s.project);
  const rows = await s.index.discover([]);
  const controller = new AbortController(); controller.abort();
  await expect(s.index.warm(rows, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  const live = new AbortController();
  await s.index.warm(rows, live.signal);
  expect(await s.index.summary(rows[0]!)).toEqual({ title: '', preview: '' });
});

it('reuses bounded summaries after restart without transcript streams or cache rewrites', async () => {
  const s = await stores(true);
  await s.write(join(s.perCwd, 'restart.jsonl'), 'restart', s.project,
    JSON.stringify({ type: 'message', message: { role: 'user', content: 'First prompt' } }) + '\n'
    + JSON.stringify({ type: 'session_info', name: 'Latest title' }) + '\n');
  await s.index.warm(await s.index.discover([]), new AbortController().signal);
  expect(reads.streams).toBe(1);
  const before = await stat(s.cachePath);
  const restarted = new LegacySessionIndex(s.owner);
  const rows = await restarted.discover([]);
  await restarted.warm(rows, new AbortController().signal);
  expect(await restarted.summary(rows[0]!)).toEqual({ title: 'Latest title', preview: 'First prompt' });
  expect(reads.streams).toBe(1);
  expect(reads.saves).toBe(1);
  expect((await stat(s.cachePath)).mtimeMs).toBe(before.mtimeMs);
});

it.each(['mtime', 'size', 'inode', 'id'] as const)('invalidates persistent summaries on %s changes', async change => {
  const s = await stores(true);
  const path = await s.write(join(s.perCwd, 'changed.jsonl'), 'changed', s.project, '{"type":"session_info","name":"Before"}\n');
  await s.index.warm(await s.index.discover([]), new AbortController().signal);
  const before = await stat(path);
  if (change === 'mtime') await utimes(path, before.atime, new Date(before.mtimeMs + 10_000));
  if (change === 'size') { await appendFile(path, '{"type":"session_info","name":"After"}\n'); await utimes(path, before.atime, before.mtime); }
  if (change === 'inode') {
    await rename(path, `${path}.old`);
    await writeFile(path, await readFile(`${path}.old`), { mode: 0o600 });
    await utimes(path, before.atime, before.mtime);
    expect((await stat(path)).ino).not.toBe(before.ino);
  }
  const restarted = new LegacySessionIndex(s.owner);
  const rows = await restarted.discover([]);
  if (change === 'id') expect(await restarted.summary({ ...rows[0]!, id: 'foreign' })).toEqual({ title: '', preview: '' });
  else expect((await restarted.summary(rows[0]!)).title).toBe(change === 'size' ? 'After' : 'Before');
  expect(reads.streams).toBe(2);
});

it.each(['malformed', 'namespace', 'agentDir', 'entry', 'snippet', 'entry-count', 'oversized', 'permissions', 'hardlink'] as const)('rebuilds a %s cache safely', async kind => {
  const s = await stores(true);
  await s.write(join(s.perCwd, 'safe.jsonl'), 'safe', s.project, '{"type":"session_info","name":"Actual"}\n');
  await s.index.warm(await s.index.discover([]), new AbortController().signal);
  const cache = JSON.parse(await readFile(s.cachePath, 'utf8'));
  if (kind === 'namespace') cache.namespace = 'foreign';
  if (kind === 'agentDir') cache.agentDir = '/foreign/store';
  if (kind === 'entry') cache.entries[0].key = '../../outside';
  if (kind === 'snippet') cache.entries[0].summary.title = 'x'.repeat(1000);
  if (kind === 'entry-count') cache.entries = Array.from({ length: 2049 }, () => cache.entries[0]);
  if (kind === 'malformed') await writeFile(s.cachePath, '{');
  else if (kind === 'oversized') await writeFile(s.cachePath, ' '.repeat(2 * 1024 * 1024 + 1));
  else await writeFile(s.cachePath, JSON.stringify(cache));
  if (kind === 'permissions') await chmod(s.cachePath, 0o644);
  if (kind === 'hardlink') await link(s.cachePath, join(s.directory, 'other-link'));
  const restarted = new LegacySessionIndex(s.owner);
  const rows = await restarted.discover([]);
  await restarted.warm(rows, new AbortController().signal);
  expect((await restarted.summary(rows[0]!)).title).toBe('Actual');
  expect(reads.streams).toBe(2);
  expect((await stat(s.cachePath)).mode & 0o777).toBe(0o600);
  const again = new LegacySessionIndex(s.owner);
  await again.warm(await again.discover([]), new AbortController().signal);
  expect(reads.streams).toBe(2);
});

it('never follows a cache symlink or writes with missing or lost ownership', async () => {
  const s = await stores(true);
  await s.write(join(s.perCwd, 'safe.jsonl'), 'safe');
  const outside = join(s.directory, 'outside');
  await writeFile(outside, 'untouched');
  await symlink(outside, s.cachePath);
  await s.index.warm(await s.index.discover([]), new AbortController().signal);
  expect(await readFile(outside, 'utf8')).toBe('untouched');
  expect((await realpath(s.cachePath))).toBe(outside);
  await rm(s.cachePath);
  const lost = new LegacySessionIndex(s.owner);
  s.assertCurrent.mockImplementation(() => { throw new Error('Ownership lost'); });
  await lost.warm(await lost.discover([]), new AbortController().signal);
  await expect(stat(s.cachePath)).rejects.toMatchObject({ code: 'ENOENT' });
  const noOwner = await stores();
  await noOwner.write(join(noOwner.perCwd, 'mock.jsonl'), 'mock');
  await noOwner.index.warm(await noOwner.index.discover([]), new AbortController().signal);
  await expect(stat(noOwner.cachePath)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('cancels active warm reads without saving incomplete work and keeps concurrency bounded', async () => {
  const s = await stores(true);
  for (let i = 0; i < 8; i++) await s.write(join(s.perCwd, `${i}.jsonl`), `session-${i}`, s.project,
    JSON.stringify({ type: 'message', message: { role: 'user', content: 'x'.repeat(1024 * 1024) } }) + '\n');
  const controller = new AbortController();
  reads.onData = () => controller.abort();
  await expect(s.index.warm(await s.index.discover([]), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(reads.streams).toBeLessThanOrEqual(2);
  await expect(stat(s.cachePath)).rejects.toMatchObject({ code: 'ENOENT' });
  reads.onData = undefined;
  await s.index.warm(await s.index.discover([]), new AbortController().signal);
  expect(reads.peak).toBeLessThanOrEqual(2);
  expect(reads.saves).toBe(1);
  expect(JSON.parse(await readFile(s.cachePath, 'utf8')).entries).toHaveLength(8);
});

it('bounds cache entries and serialized size', async () => {
  const s = await stores(true);
  const cache = new LegacySummaryCache(s.owner);
  for (let i = 0; i < 2100; i++) cache.set(join(s.perCwd, `${i}.jsonl`), '1:2:3:4', `session-${i}`, { title: 't'.repeat(120), preview: 'p'.repeat(120) });
  cache.save(new AbortController().signal);
  const data = await readFile(s.cachePath, 'utf8');
  expect(JSON.parse(data).entries).toHaveLength(2048);
  expect(Buffer.byteLength(data)).toBeLessThanOrEqual(2 * 1024 * 1024);
  const restarted = new LegacySummaryCache(s.owner);
  expect(restarted.get(join(s.perCwd, '0.jsonl'), '1:2:3:4', 'session-0')).toBeUndefined();
  expect(restarted.get(join(s.perCwd, '2099.jsonl'), '1:2:3:4', 'session-2099')?.title).toHaveLength(120);
});
