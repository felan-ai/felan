import { DaemonControlStore } from '../src/daemon/control-store.js';
import { afterEach, expect, it } from 'vitest';
import { fixture, fixtures, supported } from './fixtures/registry.js';

afterEach(async () => { for (const cleanup of fixtures.splice(0)) await cleanup(); });

it.skipIf(!supported)('publishes live-only frames, removal and execution changes in crash-safe revision order', async () => {
  const f = await fixture();
  const binding = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
  const projection = f.registry.projection(binding.sessionId);
  const initial = projection.snapshot();
  const revisions: number[] = [];
  const unsubscribe = f.registry.subscribe(binding.sessionId, event => { if ('rev' in event) revisions.push(event.rev); });
  try {
    for (let revision = 1; revision <= 40; revision++) projection.setPresentation({
      id: 'live', kind: 'document', revision, title: 'Live output', markdown: String(revision), fallback: 'Live output', actions: [],
    });
    expect(projection.snapshot().presentation).toContainEqual(expect.objectContaining({ id: 'live', revision: 40 }));
    projection.setPresentation({ id: 'live', remove: true });
    expect(projection.snapshot().presentation).not.toContainEqual(expect.objectContaining({ id: 'live' }));
    projection.setExecutionsGeneration('live-only generation');
    expect(revisions).toEqual(Array.from({ length: 42 }, (_, index) => initial.revision + index + 1));
    projection.publish({ type: 'metadata.updated', title: 'Next durable change', state: 'open', residency: 'resident' }, { title: 'Next durable change' });
    expect(f.store.session(binding.sessionId).revision).toBe(initial.revision + 43);
    const reopened = new DaemonControlStore(f.owner);
    try {
      expect(reopened.session(binding.sessionId).revision).toBeGreaterThan(revisions.at(-1)!);
      expect(reopened.session(binding.sessionId).title).toBe('Next durable change');
    } finally { reopened.close(); }
  } finally { unsubscribe(); }
});
