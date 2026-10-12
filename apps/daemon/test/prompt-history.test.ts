import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  localPromptHistoryHost,
} from '../src/prompt-history.js';

const temporaryPaths: string[] = [];

describe('local prompt history host', () => {
  it('lists regular session files and parses them without writing migrations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'felan-prompt-history-'));
    temporaryPaths.push(root);
    await mkdir(root, { recursive: true });
    const path = join(root, '2026-08-24T10-00-00-000Z_session.jsonl');
    const content = [
      JSON.stringify({ type: 'session', version: 3, id: 'one', timestamp: '2026-08-24T10:00:00Z', cwd: '/workspace' }),
      JSON.stringify({ type: 'message', id: 'prompt', parentId: null, timestamp: '2026-08-24T10:01:00Z', message: { role: 'user', content: 'inspect this' } }),
    ].join('\n');
    await writeFile(path, content);

    const listed = await localPromptHistoryHost.listSessions(root);
    expect(listed).toHaveLength(1);
    await expect(localPromptHistoryHost.readSession(listed[0]!)).resolves.toMatchObject({ cwd: '/workspace', entries: [{ type: 'message' }] });
    await expect(import('node:fs/promises').then(({ readFile }) => readFile(path, 'utf8'))).resolves.toBe(content);
  });

  it('ignores malformed and oversized historical files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'felan-prompt-history-'));
    temporaryPaths.push(root);
    const malformed = join(root, 'bad.jsonl');
    const oversized = join(root, 'large.jsonl');
    await writeFile(malformed, 'not json');
    await writeFile(oversized, 'x'.repeat(4 * 1024 * 1024 + 1));
    const refs = await localPromptHistoryHost.listSessions(root);
    expect(await localPromptHistoryHost.readSession(refs.find(({ id }) => id === malformed)!)).toBeUndefined();
    expect(await localPromptHistoryHost.readSession(refs.find(({ id }) => id === oversized)!)).toBeUndefined();
  });
});

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});
