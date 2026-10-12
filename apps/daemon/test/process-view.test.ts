import { expect, it, vi } from 'vitest';
import type { ExtensionContext } from '@felan-ai/agent-core';
import type { BackgroundBashJob, BackgroundProcessViewSource } from '@felan-ai/ext-background-bash';
import { parseProcessViewRequest, processViewAction, type ProcessViewRequest } from '@felan-ai/ext-background-bash/view';
import type { BrokerOutcome } from '../src/daemon/broker.js';
import { createBrokerProcessHost } from '../src/daemon/process-view.js';

function job(index: number): BackgroundBashJob {
  return { meta: { id: `job-${index}`, command: 'echo test', startedAt: 1 }, status: { status: 'running', updatedAt: 1 } } as BackgroundBashJob;
}
const ui = () => ({ notify: vi.fn(), setStatus: vi.fn() }) as unknown as ExtensionContext['ui'];
function reply(state: ProcessViewRequest, action: Parameters<typeof processViewAction>[1]): BrokerOutcome {
  return { state: 'answered', answer: { kind: 'custom', presenter: { id: 'felan.processes', version: '1' }, data: { ...processViewAction(state, action) } } } as BrokerOutcome;
}

it('pages all jobs, reads bounded output and signals only after a validated answer', async () => {
  const jobs = Array.from({ length: 40 }, (_, i) => job(i)); const pages: ProcessViewRequest[] = [];
  const source: BackgroundProcessViewSource = { list: vi.fn(async () => jobs), tail: vi.fn(async () => '\u0000'.repeat(10000)), stop: vi.fn(async (id: string) => jobs.find(job => job.meta.id === id)!) };
  const actions: Array<Parameters<typeof processViewAction>[1]> = [
    { action: 'page', offset: 36, select: 'last' }, { action: 'detail', id: 'job-39' }, { action: 'output', index: 0 },
    { action: 'signal', id: 'job-39', signal: 'SIGKILL' }, { action: 'close' },
  ];
  const host = createBrokerProcessHost({ signal: new AbortController().signal, unsupported() { throw new Error('unsupported'); },
    request: async value => { if (value.kind !== 'custom') throw new Error(); const state = parseProcessViewRequest(value.data); pages.push(state); return reply(state, actions.shift()!); } });
  await host.show(ui(), source, new AbortController().signal);
  expect(pages.map(page => page.jobs.length)).toEqual([18, 4, 4, 4, 4]);
  expect(pages[1]?.selectedId).toBe('job-39'); expect(pages[2]?.detail?.chunks).toBeGreaterThan(1);
  expect(pages[3]?.detail?.index).toBe(0); expect(pages[4]?.notice).toContain('Kill requested');
  expect(source.stop).toHaveBeenCalledExactlyOnceWith('job-39', 'SIGKILL');
  expect(source.list).toHaveBeenCalledTimes(3);
});

it('rejects forged control without invoking the manager', async () => {
  const stop = vi.fn(); const source = { list: async () => [job(1)], tail: vi.fn(), stop };
  const host = createBrokerProcessHost({ signal: new AbortController().signal, unsupported() { throw new Error(); }, request: async value => {
    if (value.kind !== 'custom') throw new Error();
    return { state: 'answered', answer: { kind: 'custom', presenter: value.presenter,
      data: { ...processViewAction(parseProcessViewRequest(value.data), { action: 'signal', id: 'job-1', signal: 'SIGTERM' }), id: 'other-root' } } } as BrokerOutcome;
  } });
  await expect(host.show(ui(), source, new AbortController().signal)).rejects.toThrow('Invalid process view data');
  expect(stop).not.toHaveBeenCalled();
});

it('does not start a signal after cancellation during its fresh ownership check', async () => {
  let release!: (jobs: BackgroundBashJob[]) => void; let checking!: () => void;
  const ready = new Promise<void>(resolve => { checking = resolve; });
  const source: BackgroundProcessViewSource = { list: vi.fn().mockResolvedValueOnce([job(1)]).mockImplementationOnce(() => { checking(); return new Promise(resolve => { release = resolve; }); }), tail: vi.fn(), stop: vi.fn() };
  const control = new AbortController();
  const host = createBrokerProcessHost({ signal: control.signal, unsupported() { throw new Error(); }, request: async value => {
    if (value.kind !== 'custom') throw new Error(); return reply(parseProcessViewRequest(value.data), { action: 'signal', id: 'job-1', signal: 'SIGTERM' });
  } });
  const pending = host.show(ui(), source, new AbortController().signal);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await ready; control.abort(); release([job(1)]); await rejected;
  expect(source.stop).not.toHaveBeenCalled();
});

it('shows read failures without presenting output from a different job', async () => {
  const states: ProcessViewRequest[] = []; const actions: Array<Parameters<typeof processViewAction>[1]> = [
    { action: 'detail', id: 'job-1' }, { action: 'list' }, { action: 'detail', id: 'job-2' }, { action: 'close' },
  ];
  const source: BackgroundProcessViewSource = { list: async () => [job(1), job(2)], tail: vi.fn().mockResolvedValueOnce('first job private log').mockRejectedValueOnce(new Error('read failed')), stop: vi.fn() };
  const host = createBrokerProcessHost({ signal: new AbortController().signal, unsupported() { throw new Error(); }, request: async value => {
    if (value.kind !== 'custom') throw new Error(); const state = parseProcessViewRequest(value.data); states.push(state); return reply(state, actions.shift()!);
  } });
  await host.show(ui(), source, new AbortController().signal);
  expect(states.at(-1)?.detail).toMatchObject({ id: 'job-2', text: '' }); expect(states.at(-1)?.notice).toBe('read failed');
});

it('does not publish status after the bridge has been disposed', () => {
  const control = new AbortController(); const target = ui();
  const host = createBrokerProcessHost({ signal: control.signal, request: vi.fn(), unsupported() { throw new Error(); } });
  host.status(target, 2); expect(target.setStatus).toHaveBeenCalledWith('background-bash', '2 running processes');
  control.abort(); host.status(target, undefined); expect(target.setStatus).toHaveBeenCalledTimes(1);
});
