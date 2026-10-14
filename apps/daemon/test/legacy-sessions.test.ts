import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverLegacySessions, LEGACY_SESSION_LIMITS, legacySessionDirectoryName, readTranscriptPreview, transcriptPreview } from '../src/daemon/legacy-sessions.js';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

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
  return { directory, agentDir, custom, project, other, perCwd, owner, write };
}

it('discovers per-cwd and custom-directory transcripts by header cwd, newest first', async () => {
  const s = await stores();
  const perCwd = await s.write(join(s.perCwd, 'a_per-cwd.jsonl'), 'per-cwd');
  const custom = await s.write(join(s.custom, 'b_custom.jsonl'), 'custom');
  await s.write(join(s.custom, 'c_elsewhere.jsonl'), 'elsewhere', s.other);
  expect((await discoverLegacySessions(s.owner, [], s.project)).map(row => [row.id, row.path, row.cwd]))
    .toEqual([['custom', custom, s.project], ['per-cwd', perCwd, s.project]]);
  expect((await discoverLegacySessions(s.owner, [])).map(row => row.id)).toEqual(['elsewhere', 'custom', 'per-cwd']);
});

it('skips registered, duplicate and invalid files but lists linked transcripts and deleted cwds', async () => {
  const s = await stores();
  const registered = await s.write(join(s.perCwd, 'registered.jsonl'), 'registered');
  await s.write(join(s.perCwd, 'registered-id.jsonl'), 'registered-id');
  await s.write(join(s.perCwd, 'older-duplicate.jsonl'), 'duplicate');
  await s.write(join(s.custom, 'newer-duplicate.jsonl'), 'duplicate');
  await writeFile(join(s.perCwd, 'not-json.jsonl'), '{not json\n', { mode: 0o600 });
  await writeFile(join(s.perCwd, 'no-newline.jsonl'), JSON.stringify({ type: 'session', version: 3, id: 'unterminated', cwd: s.project }), { mode: 0o600 });
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
  const found = await discoverLegacySessions(s.owner, [{ id: 'other-id', piPath: registered }, { id: 'registered-id', piPath: join(s.agentDir, 'sessions', 'x.jsonl') }]);
  expect(found.map(row => [row.id, row.path, row.cwd])).toEqual([
    ['linked', join(s.perCwd, 'linked.jsonl'), s.project],
    ['missing-cwd', join(s.custom, 'missing-cwd.jsonl'), removed],
    ['duplicate', join(s.custom, 'newer-duplicate.jsonl'), s.project],
    ['shared', join(s.perCwd, 'shared.jsonl'), s.project],
  ]);
});

it('reads the latest Pi name and the first user message from the bounded prefix', async () => {
  const s = await stores();
  const entry = (row: object) => JSON.stringify(row) + '\n';
  const user = (content: unknown) => entry({ type: 'message', id: 'm', parentId: null, timestamp: 't', message: { role: 'user', content } });
  await s.write(join(s.perCwd, 'named.jsonl'), 'named', s.project,
    user('first prompt') + entry({ type: 'session_info', name: 'Old name' }) + entry({ type: 'session_info', name: '  Release plan  ' }));
  await s.write(join(s.perCwd, 'cleared.jsonl'), 'cleared', s.project, user([{ type: 'image' }]) + user([{ type: 'text', text: 'Fix\n\tthe build' }]) + entry({ type: 'session_info', name: 'Old' }) + entry({ type: 'session_info' }));
  await s.write(join(s.perCwd, 'long.jsonl'), 'long', s.project, user('x'.repeat(500)));
  await s.write(join(s.perCwd, 'empty.jsonl'), 'empty', s.project, entry({ type: 'model_change', id: 'a', parentId: null }));
  await s.write(join(s.perCwd, 'beyond.jsonl'), 'beyond', s.project, user('y'.repeat(LEGACY_SESSION_LIMITS.headerBytes)) + entry({ type: 'session_info', name: 'Too late' }));
  const found = await discoverLegacySessions(s.owner, []);
  expect(Object.fromEntries(found.map(row => [row.id, [row.title, row.preview]]))).toEqual({ named: ['Release plan', 'first prompt'], cleared: ['', 'Fix the build'],
    long: ['', `${'x'.repeat(119)}…`], empty: ['', ''], beyond: ['', ''] });
  expect(await readTranscriptPreview(join(s.perCwd, 'cleared.jsonl'))).toBe('Fix the build');
  expect(await readTranscriptPreview(join(s.perCwd, 'beyond.jsonl'))).toBe('');
  expect(await readTranscriptPreview(join(s.perCwd, 'missing.jsonl'))).toBe('');
  expect(transcriptPreview([{ type: 'session_info', name: 'Named' }, { type: 'message', message: { role: 'assistant', content: 'no' } },
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'live\nprompt' }] } }])).toBe('live prompt');
});
