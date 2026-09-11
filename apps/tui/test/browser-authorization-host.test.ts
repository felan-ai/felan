import type { AgentRuntime, ExtensionContext } from '@felan-ai/agent-core';
import type { BrowserAuthorizationRequest } from '@felan-ai/ext-browser';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChromePreflight } from '../src/browser/chrome-devtools.js';

import { createLocalBrowserAuthorizationHost } from '../src/browser/authorization-host.js';

const openTarget = vi.fn(async () => ({ stdout: '', stderr: '', code: 0, killed: false }));
const APPLICATION = '/Applications/Google Chrome.app';

describe('local browser authorization host', () => {
  beforeEach(() => openTarget.mockClear());

  it('requires local consent before inspecting settings or creating a lease', async () => {
    const f = fixture();
    f.confirm.mockResolvedValue(false);
    await expect(f.authorize()).resolves.toMatchObject({ status: 'cancelled' });
    expect(f.inspect).not.toHaveBeenCalled();
    expect(f.createLease).not.toHaveBeenCalled();
    expect(openTarget).not.toHaveBeenCalled();
    expect(f.attention.mock.calls.map(([active]) => active)).toEqual([true, false]);
  });

  it('leaves enabled debugging untouched and passes one owned lease to attach', async () => {
    const f = fixture();
    await expect(f.authorize()).resolves.toEqual({ status: 'authorized' });
    expect(f.confirm).toHaveBeenCalledOnce();
    expect(f.confirm.mock.calls[0]?.[2]).toEqual({ signal: f.controller.signal });
    expect(openTarget).not.toHaveBeenCalled();
    expect(f.createLease).toHaveBeenCalledOnce();
    expect(f.attach).toHaveBeenCalledExactlyOnceWith(f.lease.connection, f.lease);
    expect(f.lease.close).not.toHaveBeenCalled();
    expect(f.status).toHaveBeenLastCalledWith('browser-authorization', undefined);
  });

  it('opens setup only when disabled and rechecks only after user confirmation', async () => {
    const f = fixture();
    f.inspect.mockResolvedValueOnce({ state: 'disabled', processId: 123, applicationPath: APPLICATION });
    await expect(f.authorize()).resolves.toEqual({ status: 'authorized' });
    expect(openTarget).toHaveBeenCalledExactlyOnceWith('/usr/bin/open', ['-a', APPLICATION, 'chrome://inspect/#remote-debugging'], {
      signal: f.controller.signal, timeout: 5_000, maxOutputBytes: 4_096,
    });
    expect(f.confirm).toHaveBeenCalledTimes(2);
    expect(f.inspect).toHaveBeenCalledTimes(2);
    expect(f.attach).toHaveBeenCalledOnce();
  });

  it('does not toggle or connect when enabled debugging is unavailable', async () => {
    const f = fixture();
    f.inspect.mockResolvedValue({ state: 'unavailable', reason: 'Enabled but unavailable.' });
    await expect(f.authorize()).resolves.toEqual({ status: 'unavailable', message: 'Enabled but unavailable.' });
    expect(openTarget).not.toHaveBeenCalled();
    expect(f.createLease).not.toHaveBeenCalled();
  });

  it('cancels setup without retrying and refuses a replacement Chrome process', async () => {
    const f = fixture();
    f.inspect.mockResolvedValueOnce({ state: 'disabled', processId: 123, applicationPath: APPLICATION });
    f.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(f.authorize()).resolves.toMatchObject({ status: 'cancelled' });
    expect(f.inspect).toHaveBeenCalledOnce();
    expect(f.createLease).not.toHaveBeenCalled();
    const replaced = fixture();
    replaced.inspect.mockResolvedValueOnce({ state: 'disabled', processId: 999, applicationPath: APPLICATION });
    await expect(replaced.authorize()).resolves.toMatchObject({ status: 'unavailable', message: expect.stringContaining('replaced') });
    expect(replaced.attach).not.toHaveBeenCalled();
  });

  it.each(['print', 'rpc', 'acp'])('fails closed outside the interactive TUI in %s mode', async mode => {
    const f = fixture(mode);
    await expect(f.authorize()).resolves.toMatchObject({ status: 'unavailable' });
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.inspect).not.toHaveBeenCalled();
  });

  it('propagates cancellation through dialogs and does not attach after cancellation', async () => {
    const f = fixture();
    f.inspect.mockImplementationOnce(async () => { f.controller.abort(); return READY; });
    await expect(f.authorize()).resolves.toMatchObject({ status: 'cancelled' });
    expect(f.attach).not.toHaveBeenCalled();
    expect(f.attention).toHaveBeenLastCalledWith(false);
    expect(f.status).toHaveBeenLastCalledWith('browser-authorization', undefined);
  });

  it('closes a denied connection without making a second attempt', async () => {
    const f = fixture();
    f.attach.mockResolvedValue({ ready: false });
    await expect(f.authorize()).resolves.toMatchObject({ status: 'unavailable' });
    expect(f.attach).toHaveBeenCalledOnce();
    expect(f.lease.close).toHaveBeenCalledOnce();
    expect(openTarget).not.toHaveBeenCalled();
  });

  it('does not accept native success without an established transport', async () => {
    const f = fixture();
    f.state.connected = false;
    await expect(f.authorize()).resolves.toMatchObject({ status: 'unavailable' });
    expect(f.lease.close).toHaveBeenCalledOnce();
  });

  it('clears attention and sanitizes a cleanup failure', async () => {
    const f = fixture();
    f.attach.mockResolvedValue({ ready: false });
    f.lease.close.mockRejectedValue(new Error('private endpoint ws://private.invalid/secret'));
    await expect(f.authorize()).rejects.toThrow('Chrome connection cleanup could not be confirmed.');
    expect(f.attention).toHaveBeenLastCalledWith(false);
    expect(f.status).toHaveBeenLastCalledWith('browser-authorization', undefined);
  });

  it.each(['status', 'attention'] as const)('closes failed attachment authority even when %s cleanup throws', async callback => {
    const f = fixture();
    f.attach.mockResolvedValue({ ready: false });
    if (callback === 'status') f.status.mockImplementation((_key: string, message: string | undefined) => {
      if (message === undefined) throw new Error('Presentation failed.');
    });
    else f.attention.mockImplementation((active: boolean) => {
      if (!active) throw new Error('Presentation failed.');
    });
    await expect(f.authorize()).resolves.toMatchObject({ status: 'unavailable' });
    expect(f.lease.close).toHaveBeenCalledOnce();
    expect(f.lease.signal.aborted).toBe(true);
  });

  it('suppresses private exception details and always clears attention', async () => {
    const f = fixture();
    f.attach.mockRejectedValue(new Error('private endpoint ws://private.invalid/secret'));
    const outcome = await f.authorize();
    expect(outcome.status).toBe('unavailable');
    expect(JSON.stringify(outcome)).not.toContain('private');
    expect(f.lease.close).toHaveBeenCalledOnce();
    expect(f.attention).toHaveBeenLastCalledWith(false);
  });
});

const READY = { state: 'ready', processId: 123, connection: { port: 4141, webSocketPath: '/devtools/browser' } } as const;

function fixture(mode = 'tui') {
  const controller = new AbortController();
  const leaseController = new AbortController();
  const state = { connected: true };
  const lease = {
    connection: { port: 4242, webSocketPath: '/devtools/browser/fixture' },
    signal: leaseController.signal,
    get connected() { return state.connected; },
    close: vi.fn(async () => { leaseController.abort(); }),
  };
  const confirm = vi.fn(async (_title: string, _message: string, _options?: { signal?: AbortSignal }) => true);
  const inspect = vi.fn(async (_signal: AbortSignal): Promise<ChromePreflight> => READY);
  const createLease = vi.fn(async () => lease);
  const attach = vi.fn<BrowserAuthorizationRequest['attach']>(async () => ({ ready: true }));
  const status = vi.fn();
  const attention = vi.fn();
  const runtime = { kind: 'host', exec: openTarget } as unknown as AgentRuntime;
  const request: BrowserAuthorizationRequest = {
    origin: 'https://example.com', signal: controller.signal, attach,
    extensionContext: { mode, hasUI: true, ui: { confirm, setStatus: status, notify: vi.fn() } } as unknown as ExtensionContext,
  };
  return { controller, state, lease, confirm, inspect, createLease, attach, status, attention,
    authorize: () => createLocalBrowserAuthorizationHost({ runtime, inspect, createLease, onAttention: attention }).authorize(request) };
}
