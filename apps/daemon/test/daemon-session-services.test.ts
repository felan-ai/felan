import { appendFile, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionsServiceError, type HostSessionsSelector } from '@felan-ai/agent-core';
import type { SessionRegistry } from '../src/daemon/registry.js';
import { createHostSessionsHistory, createRegistrySessionsService } from '../src/daemon/session-services.js';
import { accountPrincipal } from '../src/daemon/native-ownership.js';
import { deferred, fixture as registryFixture, fixtures, requestId, supported } from './fixtures/registry.js';

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
    await expect(f.service.list({ scope: 'visible' })).rejects.toMatchObject({ code: 'inaccessible' });
    await expect(f.service.history('current')).rejects.toMatchObject({ code: 'inaccessible' });
    expect(f.session.setSessionName).not.toHaveBeenCalled();
  });

  it('does not remap caller access failures for titles or executions', async () => {
    const f = fixture();
    const failure = new Error('Session is closing.');
    vi.mocked(f.registry.assertServiceAccess).mockImplementation(() => { throw failure; });
    await expect(f.service.setTitleIfMissing('title', 'request')).rejects.toBe(failure);
    expect(() => f.service.executions()).toThrow(failure);
  });
});

describe('host sessions history', () => {
  const directories: string[] = [];
  afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

  async function historyFixture(selector: HostSessionsSelector = { kind: 'project', cwd: '/project' }) {
    const directory = realpathSync.native(await mkdtemp(join(tmpdir(), 'host-history-')));
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
    const owner = { assertOwnsPath: vi.fn((path: string) => path), assertCurrent: vi.fn(), target: { principal: accountPrincipal() } };
    const loaded = new Set<string>();
    const registry = { assertAdmission: vi.fn(), assertServiceAccess: vi.fn(), listed: vi.fn(() => rows),
      binding: vi.fn((id: string) => loaded.has(id) ? {} : undefined),
      options: { owner, store: { sessionMetadata: vi.fn((id: string) => {
        const row = rows.find(item => item.id === id);
        if (!row) throw new Error('Session is missing.');
        return row;
      }) } } };
    const service = createHostSessionsHistory(registry as unknown as SessionRegistry, selector);
    return { service, registry, rows, entries, loaded };
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

  it('rereads a transcript changed on disk without a registry change', async () => {
    const f = await historyFixture();
    const first = await f.service.history('alpha', { limit: 1 });
    expect(first.entries).toEqual([f.entries.get('alpha')]);
    const at = { sessionId: 'alpha', revision: first.revision, branch: first.branch };
    const appended = { type: 'message', id: 'alpha-next', parentId: 'alpha-message', timestamp: '2026-08-24T10:00:01.000Z',
      message: { role: 'user', content: 'next', timestamp: 0 } };
    await appendFile(f.rows[0]!.piPath, `\n${JSON.stringify(appended)}`);
    await expect(f.service.history('alpha', { at })).rejects.toMatchObject({ code: 'stale' });
    expect((await f.service.history('alpha')).entries).toEqual([f.entries.get('alpha'), appended]);
    expect(await f.service.checkpoint('alpha')).toMatchObject({ branch: 'alpha-next' });
  });

  it('checks admission on every operation without requiring a live session', async () => {
    const f = await historyFixture();
    f.registry.assertAdmission.mockImplementation(() => { throw new Error('Admission closed'); });
    await expect(f.service.list({ scope: 'project' })).rejects.toMatchObject({ code: 'unavailable' });
    await expect(f.service.history('alpha')).rejects.toMatchObject({ code: 'unavailable' });
    await expect(f.service.checkpoint('alpha')).rejects.toMatchObject({ code: 'unavailable' });
    expect(f.registry.listed).not.toHaveBeenCalled();
    expect(f.registry.assertServiceAccess).not.toHaveBeenCalled();
  });

  it.each(['inaccessible', 'unavailable'] as const)('preserves typed %s access failures', async code => {
    const f = await historyFixture();
    const failure = new SessionsServiceError(code);
    f.registry.assertAdmission.mockImplementation(() => { throw failure; });
    await expect(f.service.list({ scope: 'project' })).rejects.toMatchObject({ code });
    await expect(f.service.history('alpha')).rejects.toMatchObject({ code });
  });

  it('invalidates the inventory when a binding opens or is evicted without a metadata change', async () => {
    const f = await historyFixture();
    const beta = f.rows.find(row => row.id === 'beta')!;
    let updatedAt = (await f.service.list({ scope: 'project' })).items.find(row => row.id === 'beta')!.updatedAt;
    for (const live of [true, false]) {
      updatedAt = Math.ceil(updatedAt / 1000) * 1000 + 1000;
      const modified = new Date(updatedAt);
      await utimes(beta.piPath, modified, modified);
      if (live) f.loaded.add('alpha'); else f.loaded.delete('alpha');
      expect((await f.service.list({ scope: 'project' })).items.find(row => row.id === 'beta')!.updatedAt).toBe(updatedAt);
      f.registry.options.owner.assertOwnsPath.mockClear();
      await f.service.list({ scope: 'project' });
      expect(f.registry.options.owner.assertOwnsPath.mock.calls.map(([path]) => path)).toEqual(live ? [f.rows[0]!.piPath] : []);
    }
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

describe.skipIf(!supported)('registry sessions history', () => {
  afterEach(async () => { for (const cleanup of fixtures.splice(0)) await cleanup(); });

  it('refreshes loaded root and child transcripts without a registry commit', async () => {
    const f = await registryFixture();
    const root = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const child = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' }, parentSessionId: root.sessionId, rootSessionId: root.sessionId });
    for (const binding of [root, child]) {
      await binding.runtime.session.prompt('first');
      f.registry.projection(binding.sessionId).refresh();
      expect(f.registry.binding(binding.sessionId)).toBe(binding);
    }
    await f.registry.settleWriters();
    const service = createHostSessionsHistory(f.registry, { kind: 'all' });
    const first = await service.list({ scope: 'visible' });
    for (const binding of [root, child]) {
      await f.registry.settleWriters();
      const stored = f.store.sessionMetadata(binding.sessionId);
      const previous = first.items.find(row => row.id === binding.sessionId)!;
      // Projection refreshes commit message entries; custom entries grow the transcript without a registry commit.
      binding.runtime.session.sessionManager.appendCustomEntry('history-test', { next: true });
      const modified = new Date(previous.updatedAt + 1000);
      await utimes(stored.piPath, modified, modified);
      expect(f.store.sessionMetadata(binding.sessionId).revision).toBe(stored.revision);
      const next = await service.list({ scope: 'visible' });
      expect(next.items.find(row => row.id === binding.sessionId)!.updatedAt).toBe(previous.updatedAt + 1000);
    }
  });

  it('reports unavailable history while the calling session is cancelling', async () => {
    const f = await registryFixture();
    const binding = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const id = binding.sessionId;
    await binding.runtime.session.prompt('first');
    f.registry.projection(id).refresh();
    const service = createRegistrySessionsService(f.registry, { id, root: id }, f.cwd);
    await service.list({ scope: 'visible' });
    await service.history(id);
    const request = requestId();
    f.store.admit({ v: 1, id: request, op: 'prompt', session: id, params: { text: 'work' } }, 'owner');
    const gate = deferred(); f.releases.add(gate.resolve);
    const work = f.registry.runAdmitted(request, id, { kind: 'tui', attachment: 'a' }, () => gate.promise);
    const cancelling = f.registry.cancel(id);
    try {
      await vi.waitFor(() => expect(f.instances.get(id)!.abort).toHaveBeenCalled());
      expect(f.store.sessionMetadata(id).run.state).toBe('cancelling');
      for (const operation of [() => service.list({ scope: 'visible' }), () => service.history(id), () => service.checkpoint(id)]) {
        const result = operation();
        await expect(result).rejects.toBeInstanceOf(SessionsServiceError);
        await expect(result).rejects.toMatchObject({ code: 'unavailable' });
      }
    } finally { gate.resolve(); await Promise.all([work, cancelling]); }
    await expect(service.history(id)).resolves.toBeDefined();
  });
});
