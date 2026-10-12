import { describe, expect, it, vi } from 'vitest';
import type { ExtensionContext } from '@felan-ai/agent-core';
import { LIMITS, parseSchema, InteractionRequestSchema } from '@felan-ai/session-protocol';
import { createLlamaPresentation } from '../src/llama/presentation.js';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function untilAborted<T>(signal: AbortSignal, value: T): Promise<T> {
  return new Promise(resolve => {
    if (signal.aborted) resolve(value);
    else signal.addEventListener('abort', () => resolve(value), { once: true });
  });
}
function fixture() {
  const signal = new AbortController(); const select = vi.fn(); const confirm = vi.fn(); const input = vi.fn(); const setStatus = vi.fn();
  const raw = { select, confirm, input, setStatus, notify: vi.fn() } as unknown as ExtensionContext['ui'];
  return { signal, select, confirm, input, setStatus, ui: createLlamaPresentation(raw, signal.signal) };
}

describe('llama.cpp broker-compatible presentation', () => {
  it('pages large catalogs and preserves exact identities behind duplicate clipped labels', async () => {
    const f = fixture(); const values = Array.from({ length: 250 }, (_, i) => `${'🦙'.repeat(1000)}${i}`);
    f.select.mockImplementation(async (title: string, choices: string[]) => {
      parseSchema(InteractionRequestSchema, { kind: 'select', title, choices: choices.map((text, i) => ({ id: String(i), title: text })), multiple: false });
      expect(choices.length).toBeLessThanOrEqual(LIMITS.choices);
      return f.select.mock.calls.length === 1 ? 'Next page' : choices[1];
    });
    await expect(f.ui.select('Long catalog', values)).resolves.toBe(values[LIMITS.choices - 1]);
  });

  it('preserves an explicit repository and supports repeated search', async () => {
    const f = fixture(); f.input.mockResolvedValueOnce('model').mockResolvedValueOnce('owner/model:Q8_0');
    f.select.mockImplementationOnce(async () => '1. Search again').mockImplementationOnce(async (_title, choices: string[]) => choices[0]);
    const search = vi.fn(async () => []); await expect(f.ui.search(search)).resolves.toBe('owner/model:Q8_0');
    expect(search).toHaveBeenCalledTimes(2);
  });

  it('closes the stop dialog when work finishes', async () => {
    const f = fixture(); const entered = deferred<void>(); const done = deferred<number>(); const closed = vi.fn();
    f.select.mockImplementation(async (_title, _choices, options: { signal: AbortSignal }) => { entered.resolve(); await untilAborted(options.signal, undefined); closed(); });
    const pending = f.ui.progress({ title: 'Loading', model: 'model', cancelTitle: 'Stop?', run: async () => done.promise, cancel: vi.fn() });
    await entered.promise; done.resolve(42); await expect(pending).resolves.toEqual({ cancelled: false, value: 42 });
    expect(closed).toHaveBeenCalledTimes(1); expect(f.setStatus).toHaveBeenLastCalledWith('llama', undefined);
  });

  it('closes confirmation without cancelling when work finishes during confirmation', async () => {
    const f = fixture(); const entered = deferred<void>(); const done = deferred<number>(); const cancel = vi.fn(); const closed = vi.fn();
    f.select.mockResolvedValue('Stop'); f.confirm.mockImplementation(async (_title, _message, options: { signal: AbortSignal }) => {
      entered.resolve(); await untilAborted(options.signal, false); closed(); return false;
    });
    const pending = f.ui.progress({ title: 'Loading', model: 'model', cancelTitle: 'Stop?', run: async () => done.promise, cancel });
    await entered.promise; done.resolve(42); await expect(pending).resolves.toEqual({ cancelled: false, value: 42 });
    expect(closed).toHaveBeenCalledTimes(1); expect(cancel).not.toHaveBeenCalled();
  });

  it('joins cancelled work after declined and accepted stop choices', async () => {
    const f = fixture(); const settled = vi.fn(); const cancel = vi.fn(async () => {});
    f.select.mockResolvedValue('Stop'); f.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await expect(f.ui.progress({ title: 'Loading', model: 'model', cancelTitle: 'Stop?', cancel,
      run: async signal => { await untilAborted(signal, undefined); settled(); throw new Error('aborted'); },
    })).resolves.toEqual({ cancelled: true });
    expect(f.confirm).toHaveBeenCalledTimes(2); expect(cancel).toHaveBeenCalledTimes(1); expect(settled).toHaveBeenCalledTimes(1);
  });

  it('joins work and closes presentation on shutdown without invoking model cancellation effects', async () => {
    const f = fixture(); const entered = deferred<void>(); const settled = vi.fn(); const cancel = vi.fn();
    f.select.mockImplementation((_title, _choices, options: { signal: AbortSignal }) => { entered.resolve(); return untilAborted(options.signal, undefined); });
    const pending = f.ui.progress({ title: 'Loading', model: 'model', cancelTitle: 'Stop?', cancel,
      run: async signal => { await untilAborted(signal, undefined); settled(); throw signal.reason; },
    });
    await entered.promise; f.signal.abort(new Error('shutdown')); await expect(pending).rejects.toThrow('shutdown');
    expect(cancel).not.toHaveBeenCalled(); expect(settled).toHaveBeenCalledTimes(1);
  });

  it('does not start an effect when the initial status cannot be published', async () => {
    const f = fixture(); f.setStatus.mockImplementation(() => { throw new Error('capacity'); }); const run = vi.fn();
    await expect(f.ui.progress({ title: 'Loading', model: 'model', cancelTitle: 'Stop?', run, cancel: vi.fn() })).rejects.toThrow('capacity');
    expect(run).not.toHaveBeenCalled();
  });
});
