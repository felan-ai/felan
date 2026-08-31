import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  installPromptHistoryKeybindingOverride,
  localPromptHistoryHost,
  removePromptHistoryShortcutFromSessionRename,
} from '../src/prompt-history.js';

const temporaryPaths: string[] = [];

describe('local prompt history host', () => {
  it('unsets Pi session rename on Ctrl+R while preserving explicit alternatives', () => {
    let bindings: Record<string, string | string[] | undefined> = {};
    const keybindings = {
      getUserBindings: () => bindings,
      setUserBindings: (next: typeof bindings) => { bindings = next; },
    };

    removePromptHistoryShortcutFromSessionRename(keybindings);
    expect(bindings['app.session.rename']).toEqual([]);

    bindings = { 'app.session.rename': ['ctrl+r', 'alt+r'], 'app.session.delete': 'ctrl+d' };
    removePromptHistoryShortcutFromSessionRename(keybindings);
    expect(bindings).toEqual({
      'app.session.rename': ['alt+r'],
      'app.session.delete': 'ctrl+d',
    });
  });

  it('reapplies the Ctrl+R override after Pi reloads keybindings', () => {
    let bindings: Record<string, string | string[] | undefined> = {};
    const reload = vi.fn(() => { bindings = {}; });
    const keybindings = {
      getUserBindings: () => bindings,
      setUserBindings: (next: typeof bindings) => { bindings = next; },
      reload,
    };

    installPromptHistoryKeybindingOverride({ keybindings });
    expect(bindings['app.session.rename']).toEqual([]);
    keybindings.reload();
    expect(reload).toHaveBeenCalledOnce();
    expect(bindings['app.session.rename']).toEqual([]);
  });

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
