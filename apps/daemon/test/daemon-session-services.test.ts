import { describe, expect, it, vi } from 'vitest';
import type { SessionRegistry } from '../src/daemon/registry.js';
import { createRegistrySessionsService } from '../src/daemon/session-services.js';

function fixture() {
  let title = '';
  const entries: Array<{ type: string; customType: string; data: unknown }> = [];
  const manager = { getSessionName: () => title, getEntries: () => entries,
    appendCustomEntry: (customType: string, data: unknown) => { entries.push({ type: 'custom', customType, data }); } };
  const session = { sessionManager: manager, setSessionName: vi.fn((value: string) => { title = value; }) };
  const stored = { id: 'current', root: 'current', revision: 0 };
  const refresh = vi.fn();
  const registry = { assertDispatch: vi.fn(), options: { owner: { assertCurrent: vi.fn() }, store: { session: () => stored } },
    binding: () => ({ runtime: { session } }), projection: () => ({ refresh, setExecutionsGeneration: vi.fn() }), subscribe: vi.fn(() => () => {}) };
  return { registry: registry as unknown as SessionRegistry, session, entries, stored,
    service: createRegistrySessionsService(registry as unknown as SessionRegistry, { id: 'current', root: 'current' }, '/project') };
}

describe('canonical Sessions binding', () => {
  it('does not access files, restore sessions, or start work while binding the service', () => {
    const f = fixture();
    expect(f.service.current).toEqual({ id: 'current', root: 'current' });
    expect(f.registry.assertDispatch).not.toHaveBeenCalled();
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
