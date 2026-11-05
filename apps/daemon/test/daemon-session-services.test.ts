import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostSessionsSelector } from '@felan-ai/agent-core';
import type { SessionRegistry } from '../src/daemon/registry.js';
import { createHostSessionsHistory, createRegistrySessionsService } from '../src/daemon/session-services.js';

function fixture() {
  let title = '';
  const entries: Array<{ type: string; customType: string; data: unknown }> = [];
  const manager = { getSessionName: () => title, getEntries: () => entries,
    appendCustomEntry: (customType: string, data: unknown) => { entries.push({ type: 'custom', customType, data }); } };
  const session = { sessionManager: manager, setSessionName: vi.fn((value: string) => { title = value; }) };
  const stored = { id: 'current', root: 'current', revision: 0 };
  const refresh = vi.fn();
  const registry = { assertDispatch: vi.fn(), assertServiceAccess: vi.fn(), options: { owner: { assertCurrent: vi.fn() }, store: { sessionMetadata: () => stored } },
    binding: () => ({ runtime: { session } }), projection: () => ({ refresh, setExecutionsGeneration: vi.fn() }), subscribe: vi.fn(() => () => {}) };
  return { registry: registry as unknown as SessionRegistry, session, entries, stored,
    service: createRegistrySessionsService(registry as unknown as SessionRegistry, { id: 'current', root: 'current' }, '/project') };
}

describe('canonical Sessions binding', () => {
  it('does not access files, restore sessions, or start work while binding the service', () => {
    const f = fixture();
    expect(f.service.current).toEqual({ id: 'current', root: 'current' });
    expect(f.registry.assertServiceAccess).not.toHaveBeenCalled();
    expect(f.session.setSessionName).not.toHaveBeenCalled();
  });

  it('gives manual titles authority and persists repeatable request outcomes', async () => {
    const f = fixture();
    expect(await f.service.setTitleIfMissing('generated', 'first')).toBe(true);
    f.session.setSessionName('manual');
    expect(await f.service.setTitleIfMissing('generated', 'first')).toBe(true);
    expect(await f.service.setTitleIfMissing('different generated', 'second')).toBe(false);
    expect(f.session.sessionManager.getSessionName()).toBe('manual');
    expect(f.entries).toHaveLength(2);
    expect(f.entries.every(entry => entry.customType === 'sessions.set-title-outcome')).toBe(true);
    await expect(f.service.setTitleIfMissing('changed payload', 'first')).rejects.toMatchObject({ code: 'invalid' });
  });

  it('reads executions from the daemon registry without a registered provider mirror', async () => {
    const f = fixture();
    const listExecutions = vi.fn(() => []);
    Object.assign(f.registry, { executionHost: () => ({ listExecutions }) });
    expect(await f.service.executions()).toEqual({ items: [] });
    expect(listExecutions).toHaveBeenCalledWith(undefined);
  });

  it('rejects identity changes before changing title or using execution authority', async () => {
    const f = fixture();
    f.stored.root = 'different';
    await expect(f.service.setTitleIfMissing('title', 'request')).rejects.toMatchObject({ code: 'inaccessible' });
    expect(f.session.setSessionName).not.toHaveBeenCalled();
  });
});

describe('host sessions history', () => {
  const directories: string[] = [];
  afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

  async function historyFixture(selector: HostSessionsSelector = { kind: 'project', cwd: '/project' }) {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'host-history-')));
    directories.push(directory);
    const timestamp = '2026-08-24T10:00:00.000Z';
    const rows = [
      { id: 'alpha', root: 'alpha', cwd: '/project' },
      { id: 'beta', root: 'beta', cwd: '/project' },
      { id: 'child', root: 'alpha', parent: 'alpha', cwd: '/other' },
      { id: 'nested', root: 'nested', cwd: '/project/nested' },
    ].map(row => ({ ...row, piPath: join(directory, `${row.id}.jsonl`), title: row.id, updatedAt: 1, state: 'closed' as const }));
    const entries = new Map(rows.map(row => [row.id,
      { type: 'message', id: `${row.id}-message`, parentId: null, timestamp, message: { role: 'user', content: row.id, timestamp: 0 } }]));
    await Promise.all(rows.map(row => writeFile(row.piPath, [
      { type: 'session', version: 3, id: row.id, cwd: row.cwd, timestamp }, entries.get(row.id),
    ].map(value => JSON.stringify(value)).join('\n'))));
    const owner = { assertOwnsPath: vi.fn((path: string) => path), assertCurrent: vi.fn(), target: { uid: process.getuid!() } };
    const registry = { assertAdmission: vi.fn(), assertServiceAccess: vi.fn(), listed: vi.fn(() => rows),
      options: { owner, store: { sessionMetadata: vi.fn(() => rows[0]!) } } };
    const service = createHostSessionsHistory(registry as unknown as SessionRegistry, selector);
    return { service, registry, rows, entries };
  }

  it('binds a frozen history-only facade without accessing a current session or storage', async () => {
    const f = await historyFixture();
    expect(Object.keys(f.service).sort()).toEqual(['checkpoint', 'current', 'history', 'list']);
    expect(Object.isFrozen(f.service)).toBe(true);
    expect(Object.isFrozen(f.service.current)).toBe(true);
    expect(f.rows.some(row => row.id === f.service.current.id || row.root === f.service.current.root)).toBe(false);
    expect(f.registry.assertAdmission).not.toHaveBeenCalled();
    expect(f.registry.listed).not.toHaveBeenCalled();
    expect(f.registry.options.owner.assertOwnsPath).not.toHaveBeenCalled();
    expect(f.registry.options.store.sessionMetadata).not.toHaveBeenCalled();
  });

  it('lists only exact project matches regardless of requested scope', async () => {
    const f = await historyFixture();
    for (const scope of ['project', 'root', 'visible'] as const) {
      expect((await f.service.list({ scope })).items.map(row => row.id).sort()).toEqual(['alpha', 'beta']);
    }
    expect(f.registry.assertAdmission).toHaveBeenCalledTimes(3);
    expect(f.registry.assertServiceAccess).not.toHaveBeenCalled();
    expect(f.registry.options.store.sessionMetadata).not.toHaveBeenCalled();
  });

  it('lists the entire inventory for an all selector and supports pagination', async () => {
    const f = await historyFixture({ kind: 'all' });
    for (const scope of ['project', 'root', 'visible'] as const) {
      expect((await f.service.list({ scope })).items.map(row => row.id).sort()).toEqual(['alpha', 'beta', 'child', 'nested']);
    }
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await f.service.list({ scope: 'project' }, { limit: 1, ...(cursor ? { cursor } : {}) });
      ids.push(...page.items.map(row => row.id)); cursor = page.nextCursor;
    } while (cursor);
    expect(ids.sort()).toEqual(['alpha', 'beta', 'child', 'nested']);
    expect((await f.service.history('child')).entries).toEqual([f.entries.get('child')]);
    expect(await f.service.checkpoint('nested')).toMatchObject({ sessionId: 'nested', branch: 'nested-message' });
  });

  it('reads selected histories and checkpoints but rejects every unselected ID', async () => {
    const f = await historyFixture();
    expect((await f.service.history('alpha')).entries).toEqual([f.entries.get('alpha')]);
    expect(await f.service.checkpoint('beta')).toMatchObject({ sessionId: 'beta', branch: 'beta-message' });
    f.registry.options.owner.assertOwnsPath.mockClear();
    for (const id of ['child', 'nested', 'missing', f.service.current.id]) {
      await expect(f.service.history(id)).rejects.toMatchObject({ code: 'inaccessible' });
      await expect(f.service.checkpoint(id)).rejects.toMatchObject({ code: 'inaccessible' });
    }
    const paths = f.registry.options.owner.assertOwnsPath.mock.calls.map(([path]) => path);
    expect(paths.every(path => path === f.rows[0]!.piPath || path === f.rows[1]!.piPath)).toBe(true);
  });

  it('copies the selector and rechecks inventory membership for later reads', async () => {
    const selector = { kind: 'project' as const, cwd: '/project' };
    const f = await historyFixture(selector);
    selector.cwd = '/other';
    expect((await f.service.list({ scope: 'project' })).items.map(row => row.id).sort()).toEqual(['alpha', 'beta']);
    f.rows[0]!.cwd = '/other';
    await expect(f.service.history('alpha')).rejects.toMatchObject({ code: 'inaccessible' });
    await expect(f.service.checkpoint('alpha')).rejects.toMatchObject({ code: 'inaccessible' });
  });

  it('checks admission on every operation without requiring a live session', async () => {
    const f = await historyFixture();
    f.registry.assertAdmission.mockImplementation(() => { throw new Error('Admission closed'); });
    await expect(f.service.list({ scope: 'project' })).rejects.toMatchObject({ code: 'inaccessible' });
    await expect(f.service.history('alpha')).rejects.toMatchObject({ code: 'inaccessible' });
    await expect(f.service.checkpoint('alpha')).rejects.toMatchObject({ code: 'inaccessible' });
    expect(f.registry.listed).not.toHaveBeenCalled();
    expect(f.registry.assertServiceAccess).not.toHaveBeenCalled();
  });

  it('preserves invalid request and abort handling', async () => {
    const f = await historyFixture({ kind: 'all' });
    await expect(f.service.list({ scope: 'invalid' as 'project' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(f.service.list({ scope: 'project' }, { limit: 0 })).rejects.toMatchObject({ code: 'invalid' });
    await expect(f.service.history('alpha', { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
    expect(() => createHostSessionsHistory(f.registry as unknown as SessionRegistry, { kind: 'unknown' } as unknown as HostSessionsSelector))
      .toThrow(expect.objectContaining({ code: 'invalid' }));
  });

  it('preserves session-bound root filtering and reads across project boundaries', async () => {
    const f = await historyFixture();
    const service = createRegistrySessionsService(f.registry as unknown as SessionRegistry, { id: 'alpha', root: 'alpha' }, '/project');
    expect((await service.list({ scope: 'root' })).items.map(row => row.id).sort()).toEqual(['alpha', 'child']);
    expect((await service.list({ scope: 'project' })).items.map(row => row.id).sort()).toEqual(['alpha', 'beta']);
    expect((await service.list({ scope: 'visible' })).items).toHaveLength(4);
    expect((await service.history('child')).entries).toEqual([f.entries.get('child')]);
    expect(f.registry.assertServiceAccess).toHaveBeenCalledWith('alpha');
    expect(f.registry.assertAdmission).not.toHaveBeenCalled();
  });
});
