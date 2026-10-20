import { afterEach, expect, it, vi } from 'vitest';
import { appendFile, mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LegacySessionIndex, legacySessionDirectoryName, readTranscriptPreview, transcriptPreview } from '../src/daemon/legacy-sessions.js';

const reads = vi.hoisted(() => ({ streams: 0 }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args);
    const createReadStream = handle.createReadStream.bind(handle);
    handle.createReadStream = (...options: Parameters<typeof createReadStream>) => { reads.streams++; return createReadStream(...options); };
    return handle;
  } };
});

const directories: string[] = [];
afterEach(async () => { reads.streams = 0; for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

async function stores() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'legacy-'))); directories.push(directory);
  const agentDir = join(directory, 'agent'); const custom = join(directory, 'custom');
  const project = join(directory, 'project'); const other = join(directory, 'other');
  const perCwd = join(agentDir, 'sessions', legacySessionDirectoryName(project));
  for (const path of [perCwd, custom, project, other]) await mkdir(path, { recursive: true, mode: 0o700 });
  const owner = { target: { agentDir, rootSet: [agentDir, custom] } };
  let age = 600;
  const write = async (path: string, id: string, cwd = project, extra = '') => {
    await writeFile(path, JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-01-01T00:00:00.000Z', cwd }) + '\n' + extra, { mode: 0o600 });
    const time = new Date(Date.now() - 1000 * age--); await utimes(path, time, time);
    return path;
  };
  return { directory, agentDir, custom, project, other, perCwd, owner, write, index: new LegacySessionIndex(owner) };
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
