import { afterEach, expect, it, vi } from 'vitest';
import { publishAgentView } from '../src/daemon/agent-view.js';
import { ControlStoreError } from '../src/daemon/control-state.js';
import { LIMITS } from '@felan-ai/session-protocol';
import { fixture, fixtures } from './fixtures/registry.js';

afterEach(async () => { vi.useRealTimers(); for (const cleanup of fixtures.splice(0)) await cleanup(); });
it.each(['Control capacity is reserved for outcomes and safety operations.', 'Presentation capacity reached.'])(
  'retries a capacity-blocked catalog without a new host event: %s', async message => {
  vi.useFakeTimers(); let changed!: () => void; const unsubscribe = vi.fn();
  const publish = vi.fn().mockImplementationOnce(() => { throw new ControlStoreError('request_capacity', message); });
  const error = vi.fn(); const stop = publishAgentView({ listLocalSubagents: () => [], subscribe: callback => { changed = () => callback([]); return unsubscribe; } } as never, publish, error);
  try {
    expect(publish).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    expect(publish).toHaveBeenCalledTimes(2); changed(); expect(publish).toHaveBeenCalledTimes(2);
    expect(error).not.toHaveBeenCalled();
  } finally { stop(); }
  changed(); await vi.advanceTimersByTimeAsync(1000); expect(publish).toHaveBeenCalledTimes(2); expect(unsubscribe).toHaveBeenCalledOnce();
});
it('classifies exhausted presentation slots as capacity and accepts a new slot after removal', async () => {
  const f = await fixture(); const binding = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
  const projection = f.registry.projection(binding.sessionId);
  for (let index = 0; index < LIMITS.pageEntries; index++) projection.setPresentation({ id: `slot-${index}`, kind: 'status', text: '' });
  expect(() => projection.setPresentation({ id: 'new-slot', kind: 'status', text: '' })).toThrow(expect.objectContaining({ code: 'request_capacity' }));
  projection.setPresentation({ id: 'slot-0', remove: true });
  expect(() => projection.setPresentation({ id: 'new-slot', kind: 'status', text: '' })).not.toThrow();
  expect(() => f.registry.assertAdmission()).not.toThrow();
});
it('does not retry storage or ownership failures as capacity pressure', () => {
  const error = new ControlStoreError('storage_failure', 'fixture'); const failed = vi.fn();
  const stop = publishAgentView({ listLocalSubagents: () => [] } as never, () => { throw error; }, failed);
  stop(); expect(failed).toHaveBeenCalledWith(error);
});
