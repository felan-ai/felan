import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Operation, OperationParams, RemoteStatus, Response } from '@felan-ai/session-protocol';
import { submitTuiInput } from '../src/tui/commands.js';
import { TuiSessionController } from '../src/tui/controller.js';
import type { TuiDialogHost } from '../src/tui/dialogs.js';
import { snapshot } from './client-fixtures.js';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
const pairing = { userCode: 'BCDF-GHJK', verificationUri: 'https://app.felan.ai/pair', verificationUriComplete: 'https://app.felan.ai/pair?code=BCDF-GHJK', expiresAt: 600_000 };
function pairingRequests(f: ReturnType<typeof fixture>, polls: RemoteStatus[]) {
  f.request.mockImplementation(async (op: Operation, params: OperationParams<Operation>) => {
    if (op === 'remote.status') return { outcome: 'accepted', result: polls.shift()! };
    if (op === 'remote.configure' && (params as { action?: string }).action === 'login') return { outcome: 'accepted', result: pending };
    return { outcome: 'accepted', result: { ...status, configured: false, state: 'off' } };
  });
}
function holdPrompt(dialogs: TuiDialogHost) {
  vi.mocked(dialogs.select).mockImplementation((_title, _choices, options) => new Promise(resolve => {
    options?.signal?.addEventListener('abort', () => resolve(undefined));
  }));
}
const operations: Operation[] = ['remote.status', 'remote.configure', 'session.remote', 'host.status'];
const status: RemoteStatus = { configured: true, share: 'on-request', state: 'connected', apiUrl: 'https://app.felan.ai',
  host: { id: '12345678-1234-1234-1234-123456789abc' }, pending: 3, sessions: 2,
  projects: [{ id: 'project', name: 'Example', path: '/fixture' }] };
const pending: RemoteStatus = { ...status, configured: false, state: 'connecting', pairing };
const connected: RemoteStatus = { ...status };

function fixture(options: { status?: Partial<RemoteStatus>; operations?: Operation[]; attached?: boolean; failure?: Response; openBrowser?: (url: string) => Promise<unknown> } = {}) {
  const remote = { ...status, ...options.status };
  const request = vi.fn(async (op: Operation, _params: OperationParams<Operation>) => {
    if (options.failure) return options.failure;
    return { outcome: 'accepted', result: op === 'remote.status' || op === 'remote.configure' ? remote : {} };
  });
  const controller = new TuiSessionController({ status: 'ready', capabilities: { operations: options.operations ?? operations },
    subscribe: () => () => {}, request } as unknown as ConstructorParameters<typeof TuiSessionController>[0]);
  vi.spyOn(controller, 'sessionId', 'get').mockReturnValue(options.attached === false ? undefined : 'session');
  vi.spyOn(controller, 'snapshot', 'get').mockReturnValue(options.attached === false ? undefined : snapshot());
  const dialogs: TuiDialogHost = { input: vi.fn(async () => undefined), select: vi.fn(async () => undefined), confirm: vi.fn(async () => false) };
  const openBrowser = options.openBrowser ?? vi.fn(async () => undefined);
  const submit = (text: string) => submitTuiInput(controller, dialogs, text, { cwd: '/wrong-fallback', exit() {}, openBrowser });
  return { controller, dialogs, request, submit };
}

describe('/remote', () => {
  it.each(['/remote', '/remote status'])('shows a compact status for %s without requiring a session', async text => {
    const f = fixture({ attached: false, status: { state: 'stopped', reason: 'unsupported_schema', message: 'Update Felan to resume sharing.', supported: { protocol: [1], rowSchemaVersion: [1] } } });
    expect(await f.submit(text)).toBe(true);
    expect(f.request).toHaveBeenCalledExactlyOnceWith('remote.status', {}, {});
    expect(f.dialogs.select).toHaveBeenCalledWith('Remote stopped · unsupported_schema', expect.arrayContaining([
      { value: 'message', label: 'Update Felan to resume sharing.' },
      { value: 'host', label: 'Host: 12345678 · paired' },
      { value: 'share', label: 'Share: on-request' },
      { value: 'summary', label: '3 pending events · 2 shared sessions' },
      { value: 'project', label: 'Project: Example · /fixture' },
      { value: 'api', label: 'API: https://app.felan.ai' },
      { value: 'supported', label: 'Supported protocol: 1 · row schema: 1' },
    ]));
  });

  it.each([true, false])('shares the current session, explaining when login is needed (configured: %s)', async configured => {
    const f = fixture({ status: { configured } });
    expect(await f.submit('/remote on')).toBe(true);
    expect(f.request.mock.calls).toEqual([['remote.status', {}, {}], ['session.remote', { shared: true }, { session: 'session' }]]);
    expect(f.controller.notice).toContain('Sharing this session with Felan');
    expect(f.controller.notice.includes('Sharing starts after /remote login')).toBe(!configured);
  });

  it('stops sharing but explains that already shared history remains', async () => {
    const f = fixture(); expect(await f.submit('/remote off')).toBe(true);
    expect(f.request).toHaveBeenCalledExactlyOnceWith('session.remote', { shared: false }, { session: 'session' });
    expect(f.controller.notice).toBe('Stopped sharing this session. Already shared history stays on Felan.');
  });

  it.each([
    ['/remote logout', { action: 'logout' }],
    ['/remote share all', { action: 'share', share: 'all' }],
    ['/remote share on-request', { action: 'share', share: 'on-request' }],
    ['/remote open', { action: 'open_project', path: '/fixture' }],
    ['/remote open My project', { action: 'open_project', path: '/fixture', name: 'My project' }],
  ] as const)('dispatches %s', async (text, params) => {
    const f = fixture(); expect(await f.submit(text)).toBe(true);
    expect(f.request).toHaveBeenCalledExactlyOnceWith('remote.configure', params, {});
    expect(f.controller.notice).not.toBe('');
  });

  it('closes only the project matching the current session cwd', async () => {
    const f = fixture({ status: { projects: [{ id: 'wrong', path: '/wrong-fallback', name: 'Other' }, ...status.projects] } });
    expect(await f.submit('/remote close')).toBe(true);
    expect(f.request.mock.calls).toEqual([['remote.status', {}, {}], ['remote.configure', { action: 'close_project', id: 'project' }, {}]]);
    expect(f.controller.notice).toContain('Closed the remote project');
  });

  it('explains when no project is open for the current directory', async () => {
    const f = fixture({ status: { projects: [] } }); expect(await f.submit('/remote close')).toBe(false);
    expect(f.request).toHaveBeenCalledExactlyOnceWith('remote.status', {}, {});
    expect(f.controller.notice).toBe('No remote project is open for this directory.');
  });

  it.each(['on', 'off', 'open', 'close'])('requires an attached session for /remote %s', async action => {
    const f = fixture({ attached: false }); await expect(f.submit(`/remote ${action}`)).rejects.toThrow('No session is attached');
    expect(f.request).not.toHaveBeenCalled();
  });

  it.each(operations.slice(0, 3))('gates all remote commands if %s is not advertised', async missing => {
    const f = fixture({ operations: operations.filter(op => op !== missing) });
    for (const action of ['', 'status', 'on', 'off', 'login', 'logout', 'share all', 'open', 'close']) expect(await f.submit(`/remote ${action}`)).toBe(false);
    expect(f.controller.notice).toBe('Remote sessions are not available from this daemon');
    expect(f.request).not.toHaveBeenCalled(); expect(f.dialogs.input).not.toHaveBeenCalled();
  });

  it.each(['unknown', 'on extra', 'off extra', 'status extra', 'logout extra', 'close extra', 'share', 'share none', 'share all extra'])('shows usage for /remote %s', async action => {
    const f = fixture(); expect(await f.submit(`/remote ${action}`)).toBe(false);
    expect(f.controller.notice).toContain('Usage: /remote'); expect(f.request).not.toHaveBeenCalled();
  });

  it.each(['fln_pat_inline', 'https://user:password@example.com', 'file:///tmp/example', 'https://example.com?key=fln_pat_inline', 'https://example.com extra'])('rejects invalid or credential-bearing login URLs (%s)', async url => {
    const f = fixture(); expect(await f.submit(`/remote login ${url}`)).toBe(false);
    expect(f.controller.notice).toBe('Usage: /remote login [http(s)://apiUrl]');
    expect(f.request).not.toHaveBeenCalled(); expect(f.dialogs.input).not.toHaveBeenCalled();
  });

  it('surfaces daemon rejections without replacing them with success', async () => {
    const f = fixture({ failure: { v: 1, re: 'request', outcome: 'rejected', error: { code: 'forbidden', message: 'Web-created sessions must remain shared.', retryable: false } } });
    expect(await f.submit('/remote off')).toBe(false); expect(f.controller.notice).toContain('Web-created sessions must remain shared.');
  });
});

describe('/remote login with browser pairing', () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it.each([undefined, 'http://localhost:3000'])('starts pairing without a token prompt (apiUrl: %s)', async apiUrl => {
    const f = fixture({ attached: false }); pairingRequests(f, [connected]); holdPrompt(f.dialogs);
    const done = f.submit(`/remote login${apiUrl ? ` ${apiUrl}` : ''}`);
    await vi.runAllTimersAsync();
    expect(await done).toBe(true);
    expect(f.dialogs.input).not.toHaveBeenCalled();
    expect(f.request.mock.calls[0]).toEqual(['remote.configure', { action: 'login', ...(apiUrl ? { apiUrl } : {}) }, {}]);
    expect(f.controller.notice).toBe('Felan login saved · this machine is paired');
  });

  it('shows the code and URL, opens the verification page, and polls until connected', async () => {
    const open = vi.fn(async () => undefined);
    const f = fixture({ attached: false, openBrowser: open }); pairingRequests(f, [pending, connected]); holdPrompt(f.dialogs);
    const done = f.submit('/remote login');
    await vi.runAllTimersAsync();
    expect(await done).toBe(true);
    expect(f.dialogs.select).toHaveBeenCalledWith(expect.stringContaining('Code: BCDF-GHJK'), [{ value: 'cancel', label: 'Cancel pairing' }],
      expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(open).toHaveBeenCalledExactlyOnceWith('https://app.felan.ai/pair?code=BCDF-GHJK');
    expect(f.request.mock.calls.filter(([op]) => op === 'remote.status')).toHaveLength(2);
  });

  it('keeps the code on screen when the browser cannot be opened', async () => {
    const f = fixture({ attached: false, openBrowser: vi.fn(() => { throw new Error('no browser'); }) });
    pairingRequests(f, [connected]); holdPrompt(f.dialogs);
    const done = f.submit('/remote login'); await vi.runAllTimersAsync();
    expect(await done).toBe(true);
    expect(f.dialogs.select).toHaveBeenCalledWith(expect.stringContaining('BCDF-GHJK'), expect.anything(), expect.anything());
    expect(f.controller.notice).toBe('Felan login saved · this machine is paired');
  });

  it.each([
    ['pairing_denied', 'Browser pairing was denied on Felan. Run /remote login to try again.'],
    ['pairing_expired', 'The browser pairing code expired before it was approved. Run /remote login to get a new code.'],
  ] as const)('reports %s as a login that did not complete', async (reason, message) => {
    const f = fixture({ attached: false }); pairingRequests(f, [{ ...status, configured: false, state: 'stopped', reason, message }]); holdPrompt(f.dialogs);
    const done = f.submit('/remote login'); await vi.runAllTimersAsync();
    expect(await done).toBe(false);
    expect(f.controller.notice).toBe(`Felan login not completed · ${message}`);
  });

  it.each([['the cancel option', 'cancel'], ['Escape', undefined]] as const)('cancels the wait with %s without logging out', async (_label, answer) => {
    const f = fixture({ attached: false }); pairingRequests(f, [pending]);
    vi.mocked(f.dialogs.select).mockResolvedValue(answer);
    expect(await f.submit('/remote login')).toBe(false);
    expect(f.request.mock.calls.map(([op]) => op)).toEqual(['remote.configure', 'remote.configure']);
    expect(f.request).toHaveBeenLastCalledWith('remote.configure', { action: 'cancel_pairing' }, {});
    expect(f.controller.notice).toBe('Felan login cancelled.');
  });

  it('reports a pairing that was approved before the cancel arrived', async () => {
    const f = fixture({ attached: false }); pairingRequests(f, [pending]);
    const respond = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (op: Operation, params: OperationParams<Operation>) => (params as { action?: string }).action === 'cancel_pairing'
      ? { outcome: 'accepted', result: { ...status, state: 'connecting', message: 'Browser pairing was already approved; this machine is paired.' } }
      : respond(op, params));
    vi.mocked(f.dialogs.select).mockResolvedValue('cancel');
    expect(await f.submit('/remote login')).toBe(false);
    expect(f.controller.notice).toBe('Felan login · Browser pairing was already approved; this machine is paired.');
  });

  it('tells the user when a cancelled re-login reconnects with the existing pairing', async () => {
    const f = fixture({ attached: false }); pairingRequests(f, [pending]);
    const respond = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (op: Operation, params: OperationParams<Operation>) => (params as { action?: string }).action === 'cancel_pairing'
      ? { outcome: 'accepted', result: { ...status, state: 'connecting' } } : respond(op, params));
    vi.mocked(f.dialogs.select).mockResolvedValue('cancel');
    expect(await f.submit('/remote login')).toBe(false);
    expect(f.controller.notice).toBe('Felan login cancelled · reconnecting with the existing pairing');
  });

  it('reports a stopped pairing in the notice and as a remote need in daemon status', async () => {
    const f = fixture(); pairingRequests(f, [{ ...status, configured: false, state: 'stopped', reason: 'pairing_denied', message: 'Browser pairing was denied on Felan. Run /remote login to try again.' }]);
    holdPrompt(f.dialogs);
    const done = f.submit('/remote login'); await vi.runAllTimersAsync();
    expect(await done).toBe(false); expect(f.controller.notice).toContain('Browser pairing was denied on Felan');
    vi.mocked(f.dialogs.select).mockResolvedValue(undefined);
    f.request.mockResolvedValueOnce({ outcome: 'accepted', result: { daemonVersion: 'fixture', state: 'ready', active: { sessions: 1, runs: 0, work: 0, attachments: 1 },
      setupNeeds: [{ code: 'remote', message: 'Browser pairing was denied on Felan. Run /remote login to try again.' }] } } as never);
    expect(await f.submit('/daemon status')).toBe(true);
    expect(f.dialogs.select).toHaveBeenCalledWith('Daemon fixture · ready', expect.arrayContaining([
      { value: 'remote', label: 'Remote: Browser pairing was denied on Felan. Run /remote login to try again.' },
    ]));
  });
});
