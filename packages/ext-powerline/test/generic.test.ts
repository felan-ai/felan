import { expect, it, vi } from 'vitest';
import type { ExtensionUi, UiElementHandle, UiInteractiveElement } from '@felan-ai/agent-core';
import { createGenericPowerlinePresentation } from '../src/generic.js';
import { parsePowerlineData } from '../src/data.js';

function fixture() {
  const elements: UiInteractiveElement[] = [];
  const update = vi.fn<UiElementHandle['update']>().mockImplementation(async element => { elements.push(element); });
  const close = vi.fn<UiElementHandle['close']>().mockResolvedValue(undefined);
  const ui = {
    present: vi.fn<ExtensionUi['present']>().mockImplementation(async element => { elements.push(element); return { update, close }; }),
    status: vi.fn<ExtensionUi['status']>().mockResolvedValue(undefined),
    removeStatus: vi.fn<ExtensionUi['removeStatus']>().mockResolvedValue(undefined),
  };
  const host = createGenericPowerlinePresentation(ui as unknown as ExtensionUi);
  const data = parsePowerlineData({ segments: [{ name: 'directory', colorKey: 'directory', values: { cwd: 'model 界 🧪' } }] });
  return { elements, ui, update, close, host, data };
}

it('publishes semantic values without style, symbols or layout in every generic row', async () => {
  const h = fixture();
  expect(h.host.publish(h.data)).toBe(true);
  await h.host.settle!();
  expect(h.elements).toHaveLength(1);
  const element = h.elements[0]!;
  expect(element).toMatchObject({ kind: 'view', actions: [], hint: { id: 'felan.powerline', version: '3.0.0' } });
  if (element.kind !== 'view') throw new Error('Expected view');
  expect(element.items).toEqual([{ id: 'directory', values: { segment: 'directory', color: 'directory', data: JSON.stringify({ cwd: 'model 界 🧪' }) }, fallback: expect.any(String) }]);
  h.host.clear(); await h.host.settle!(); expect(h.close).toHaveBeenCalledOnce();
});

it('coalesces blocked publishing, snapshots caller data, and monotonically updates revisions', async () => {
  const h = fixture();
  const entered = deferred<void>();
  const finish = deferred<UiElementHandle>();
  h.ui.present.mockImplementationOnce(async element => { h.elements.push(element); entered.resolve(); return finish.promise; });
  h.host.publish(h.data);
  await entered.promise;
  const skipped = parsePowerlineData({ segments: [{ name: 'directory', colorKey: 'directory', values: { cwd: 'skipped' } }] });
  const last = parsePowerlineData({ segments: [{ name: 'directory', colorKey: 'directory', values: { cwd: 'latest' } }] });
  h.host.publish(skipped);
  h.host.publish(last);
  if (last.segments[0]?.name === 'directory') last.segments[0].values.cwd = 'changed by caller';
  finish.resolve({ update: h.update, close: h.close });
  await h.host.settle!();
  expect(h.update).toHaveBeenCalledOnce();
  const updated = h.update.mock.calls[0]![0];
  expect(updated.revision).toBe(2);
  expect(JSON.stringify(updated)).toContain('latest');
  expect(JSON.stringify(h.elements)).not.toContain('skipped');
  expect(JSON.stringify(updated)).not.toContain('changed by caller');
  h.host.clear();
  await h.host.settle!();
});

it('joins an in-flight publish after abort and closes a late-created handle exactly once', async () => {
  const h = fixture();
  const entered = deferred<void>();
  const finish = deferred<UiElementHandle>();
  h.ui.present.mockImplementationOnce(async () => { entered.resolve(); return finish.promise; });
  h.host.publish(h.data);
  await entered.promise;
  const signal = h.ui.present.mock.calls[0]![1]!.signal!;
  h.host.clear();
  h.host.clear();
  let settled = false;
  const settlement = h.host.settle!().then(() => { settled = true; });
  expect(signal.aborted).toBe(true);
  expect(settled).toBe(false);
  expect(h.host.publish(h.data)).toBe(false);
  finish.resolve({ update: h.update, close: h.close });
  await settlement;
  expect(h.close).toHaveBeenCalledOnce();
  expect(h.update).not.toHaveBeenCalled();
});

it('keeps cleanup failure observable and sanitizes rejected publication data', async () => {
  const h = fixture();
  h.ui.status.mockRejectedValueOnce(new Error('private credential'));
  h.close.mockRejectedValueOnce(new Error('private cleanup detail'));
  h.host.publish(h.data, { session: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.12345 } });
  const result = h.host.settle!();
  await expect(result).rejects.toThrow('Powerline data cleanup failed.');
  await expect(result).rejects.not.toThrow('private');
  expect(() => h.host.publish(h.data)).toThrow('Powerline');
  expect(h.close).toHaveBeenCalledOnce();
  expect(h.ui.removeStatus).toHaveBeenCalledWith('powerline-session-input');
  await expect(h.host.settle!()).rejects.toThrow('Powerline');
});

it('removes disappeared numeric statuses rather than publishing fabricated values', async () => {
  const h = fixture();
  h.host.publish(h.data, { session: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.12345 } });
  await h.host.settle!();
  expect(h.ui.status).toHaveBeenCalledWith(expect.objectContaining({ value: { kind: 'money', value: 0.12345, currency: 'USD' } }));
  h.host.publish(h.data);
  await h.host.settle!();
  expect(h.ui.removeStatus).toHaveBeenCalledTimes(5);
  h.host.clear();
  await h.host.settle!();
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}
