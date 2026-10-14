import { DaemonControlStore } from '../src/daemon/control-store.js';
import { afterEach, expect, it } from 'vitest';
import { fixture, fixtures, supported } from './fixtures/registry.js';

afterEach(async () => { for (const cleanup of fixtures.splice(0)) await cleanup(); });

it.skipIf(!supported)('publishes transient frames and removal in revision order with one crash-safe revision reservation', async () => {
  let writes = 0;
  const f = await fixture({ fault: boundary => { if (boundary === 'before_write') writes++; } });
  const binding = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
  const projection = f.registry.projection(binding.sessionId);
  const initial = projection.snapshot();
  const before = writes;
  const revisions: number[] = [];
  const unsubscribe = f.registry.subscribe(binding.sessionId, event => { if ('rev' in event) revisions.push(event.rev); });
  try {
    for (let revision = 1; revision <= 40; revision++) projection.setPresentation({
      id: 'live', kind: 'document', revision, title: 'Live output', markdown: String(revision), fallback: 'Live output', actions: [],
    });
    expect(projection.snapshot().presentation).toContainEqual(expect.objectContaining({ id: 'live', revision: 40 }));
    projection.setPresentation({ id: 'live', remove: true });
    expect(projection.snapshot().presentation).not.toContainEqual(expect.objectContaining({ id: 'live' }));
    expect(writes).toBe(before + 1);
    expect(revisions).toEqual(Array.from({ length: 41 }, (_, index) => initial.revision + index + 1));
    projection.publish({ type: 'metadata.updated', title: 'Next durable change', state: 'open', residency: 'resident' }, { title: 'Next durable change' });
    expect(writes).toBe(before + 2);
    expect(f.store.session(binding.sessionId).revision).toBe(initial.revision + 42);
    const reopened = new DaemonControlStore(f.owner);
    try {
      expect(reopened.session(binding.sessionId).revision).toBeGreaterThan(revisions.at(-1)!);
      expect(reopened.session(binding.sessionId).title).toBe('Next durable change');
    } finally { reopened.close(); }
  } finally { unsubscribe(); }
});


it.skipIf(!supported)('reserves the next revision block only after exhausting the current block', async () => {
  let writes = 0;
  const f = await fixture({ fault: boundary => { if (boundary === 'before_write') writes++; } });
  const binding = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
  const initial = f.store.session(binding.sessionId).revision;
  const before = writes;
  for (let index = 1; index <= 4097; index++) {
    expect(f.store.advanceTransientRevision(binding.sessionId)).toBe(initial + index);
  }
  expect(writes).toBe(before + 2);
});
