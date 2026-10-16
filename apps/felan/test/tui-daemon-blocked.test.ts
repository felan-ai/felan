import { expect, it, vi } from 'vitest';
import type { HostBlocked } from '@felan-ai/session-protocol';
import type { SessionClient } from '../src/client/client.js';
import { submitTuiInput } from '../src/tui/commands.js';
import { TuiSessionController } from '../src/tui/controller.js';
import type { NavigationDialogs } from '../src/tui/session-navigator.js';
import { runDaemonFelan } from '../src/client-application.js';

const blocked: HostBlocked = { recoverable: true, since: 1, message: 'disposal failed', step: 'session-services', session: 'abcdefgh-long-session', pid: 42 };
const explanation = 'Daemon shutdown failed at session-services (session abcdefgh): disposal failed.';
const kill = process.platform === 'win32' ? 'taskkill /F /PID 42' : 'kill -9 42';
const manual = `Cleanup cannot be retried safely; force-terminate the daemon process (pid 42) with \`${kill}\`, then start Felan again.`;

function fixture(detail = blocked, answer = true) {
  const request = vi.fn(async () => ({ outcome: 'accepted', result: { daemonVersion: 'fixture', state: 'blocked', blocked: detail,
    active: { sessions: 1, runs: 0, work: 0, attachments: 1 }, setupNeeds: [] } }));
  const client = { status: 'ready', capabilities: { operations: ['host.status', 'prompt', 'sessions.create'] }, request,
    subscribe: () => () => {}, connect: async () => {}, close() {} } as unknown as SessionClient;
  const controller = new TuiSessionController(client);
  const confirm = vi.fn(async () => answer); const select = vi.fn(async () => undefined);
  const dialogs = { confirm, select } as unknown as NavigationDialogs;
  const daemon = vi.fn(async () => {});
  return { controller, request, confirm, select, daemon, submit: (input: string) => submitTuiInput(controller, dialogs, input, { cwd: '/fixture', exit() {}, daemon }) };
}

it('shows the failed cleanup and TUI recovery command in /daemon status', async () => {
  const f = fixture(); expect(await f.submit('/daemon status')).toBe(true);
  expect(f.select).toHaveBeenCalledWith('Daemon fixture · blocked', expect.arrayContaining([
    { value: 'blocked', label: 'Incomplete shutdown', description: `${explanation} Use /daemon restart force to retry cleanup.` },
  ]), { initialValue: 'blocked' });
  expect(f.daemon).not.toHaveBeenCalled();
});

it.each(['/daemon stop', '/daemon restart', '/restart'])('confirms forced cleanup for %s even with no active tasks', async command => {
  const f = fixture(); expect(await f.submit(command)).toBe(true);
  expect(f.confirm).toHaveBeenCalledExactlyOnceWith('Retry daemon cleanup with force?', `${explanation} Remaining work will be interrupted.`);
  expect(f.daemon).toHaveBeenCalledExactlyOnceWith(command === '/restart' ? 'relaunch' : command.endsWith('stop') ? 'stop' : 'restart', true);
  expect(f.request).toHaveBeenCalledExactlyOnceWith('host.status', {}, {});
});

it.each(['/daemon stop', '/daemon restart', '/restart'])('cancels %s without sending lifecycle control', async command => {
  const f = fixture(blocked, false); expect(await f.submit(command)).toBe(false);
  expect(f.confirm).toHaveBeenCalledOnce(); expect(f.daemon).not.toHaveBeenCalled();
});

it.each(['/daemon stop force', '/daemon restart force', '/restart force'])('uses force directly for %s', async command => {
  const f = fixture(); expect(await f.submit(command)).toBe(true);
  expect(f.confirm).not.toHaveBeenCalled();
  expect(f.daemon).toHaveBeenCalledExactlyOnceWith(command.startsWith('/restart') ? 'relaunch' : command.includes('stop') ? 'stop' : 'restart', true);
});

it.each(['/daemon stop', '/daemon restart', '/restart', '/daemon restart force', '/daemon stop force'])('never sends %s when cleanup is unsafe to retry', async command => {
  const f = fixture({ ...blocked, recoverable: false }); expect(await f.submit(command)).toBe(false);
  expect(f.controller.notice).toBe(`${explanation} ${manual}`);
  expect(f.confirm).not.toHaveBeenCalled(); expect(f.daemon).not.toHaveBeenCalled();
});

it('shows manual recovery instead of force in unrecoverable status', async () => {
  const f = fixture({ ...blocked, recoverable: false }); await f.submit('/daemon status');
  expect(f.select).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining([{ value: 'blocked', label: 'Incomplete shutdown', description: `${explanation} ${manual}` }]), { initialValue: 'blocked' });
});

it.each([[true, 'Use /daemon restart force to retry cleanup.'], [false, manual]])('explains repeated host_blocked rejections once from daemon status (recoverable: %s)', async (recoverable, hint) => {
  const refusal = 'The daemon is blocked after an incomplete shutdown and refuses new work. Retry the stop or restart with force.';
  const f = fixture({ ...blocked, recoverable }); const status = f.request.getMockImplementation()!;
  f.request.mockImplementation((async (op: string, ...rest: unknown[]) => op === 'host.status' ? (status as (...args: unknown[]) => unknown)(op, ...rest)
    : { outcome: 'rejected', error: { code: 'host_blocked', message: refusal } }) as never);
  await f.controller.perform('prompt', { text: 'keep this' }, 'session');
  expect(f.controller.notice).toBe(refusal);
  await vi.waitFor(() => expect(f.controller.notice).toBe(`Daemon refuses new work. ${explanation} ${hint}`));
  await f.controller.perform('sessions.create', { cwd: '/fixture', source: 'tui' });
  expect(f.controller.notice).toBe(`Daemon refuses new work. ${explanation} ${hint}`);
  expect(f.controller.notes).toHaveLength(1); expect(f.controller.notes[0]?.text).toBe(f.controller.notice);
  expect(f.request.mock.calls.filter(([op]) => op === 'host.status')).toHaveLength(1);
});

it('keeps the daemon refusal when its status is unavailable', async () => {
  const f = fixture(); f.request.mockResolvedValue({ outcome: 'rejected', error: { code: 'host_blocked', message: 'Cleanup cannot be retried safely; terminate the daemon process 42.' } } as never);
  await f.controller.perform('prompt', { text: 'keep this' }, 'session');
  await vi.waitFor(() => expect(f.request.mock.calls.map(([op]) => op)).toEqual(['prompt', 'host.status']));
  expect(f.controller.notice).toBe('Cleanup cannot be retried safely; terminate the daemon process 42.'); expect(f.controller.notes).toHaveLength(1);
});

it('does not run a lifecycle action when the status operation is rejected', async () => {
  const f = fixture(); f.request.mockResolvedValue({ outcome: 'rejected', error: { code: 'host_blocked', message: 'blocked' } } as never);
  expect(await f.submit('/daemon restart')).toBe(false); expect(f.daemon).not.toHaveBeenCalled(); expect(f.confirm).not.toHaveBeenCalled();
});

it('replaces the rejection notice only after reconnect verifies the daemon recovered', async () => {
  const f = fixture(); f.request.mockResolvedValueOnce({ outcome: 'rejected', error: { code: 'host_blocked', message: 'blocked' } } as never);
  await f.controller.perform('sessions.create', { cwd: '/fixture', source: 'tui' });
  await vi.waitFor(() => expect(f.controller.notice).toContain(explanation));
  const notice = f.controller.notice;
  await f.controller.reconnect();
  expect(f.controller.notice).toBe(notice);
  f.request.mockResolvedValue({ outcome: 'accepted', result: { state: 'ready' } } as never);
  await f.controller.reconnect();
  expect(f.controller.notice).toBe('Daemon reconnected.'); expect(f.controller.notes).toHaveLength(1);
  f.controller.setNotice('Keep this unrelated notice.'); await f.controller.reconnect();
  expect(f.controller.notice).toBe('Keep this unrelated notice.');
});

it.each(['stop', 'restart', 'relaunch'] as const)('uses the TUI hint after a rejected %s control', async action => {
  const control = vi.fn(async () => ({ outcome: 'rejected', blocked, error: { code: 'host_blocked', message: 'Cleanup needs force.' } }));
  const client = { identity: { instanceId: 'old' }, subscribe: () => () => {}, close() {}, control } as unknown as SessionClient;
  await runDaemonFelan({ agentDir: '/fixture', daemonRuntime: '/fixture/runtime' }, { createClient: () => client, runTerminal: async (_controller, options) => {
    await expect(options.onDaemonAction!(action, false, '')).rejects.toThrow(`${explanation} Use /daemon ${action === 'stop' ? 'stop' : 'restart'} force to retry cleanup.`);
  } });
});

it('reports the manual PID instruction after rejected forced recovery', async () => {
  const client = { identity: { instanceId: 'old' }, subscribe: () => () => {}, close() {},
    control: async () => ({ outcome: 'rejected', blocked: { ...blocked, recoverable: false }, error: { code: 'host_blocked', message: 'Cleanup cannot be repeated.' } }) } as unknown as SessionClient;
  await runDaemonFelan({ daemonRuntime: '/fixture/runtime' }, { createClient: () => client, runTerminal: async (_controller, options) => {
    await expect(options.onDaemonAction!('restart', true, '')).rejects.toThrow(`${explanation} ${manual}`);
  } });
});

it('reports a fresh blocked failure with the TUI hint while waiting after force', async () => {
  const control = vi.fn(async (op: string) => op === 'host.status'
    ? { outcome: 'accepted', state: 'blocked', blocked: { ...blocked, message: 'retry failed' } }
    : { outcome: 'accepted', state: 'draining' });
  const connect = vi.fn(); const client = { identity: { instanceId: 'old' }, subscribe: () => () => {}, close() {}, control, connect } as unknown as SessionClient;
  await runDaemonFelan({ daemonRuntime: '/fixture/runtime' }, { createClient: () => client, runTerminal: async (controller, options) => {
    try { await options.onDaemonAction!('restart', true, ''); }
    catch (error) { controller.setNotice((error as Error).message); }
    expect(controller.notice).toBe('Daemon shutdown failed at session-services (session abcdefgh): retry failed. Use /daemon restart force to retry cleanup.');
  } });
  expect(control.mock.calls).toEqual([['host.restart', 'force'], ['host.status']]); expect(connect).not.toHaveBeenCalled();
});
