import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Operation, OperationParams, RemoteStatus, Response } from '@felan-ai/session-protocol';
import { submitTuiInput } from '../src/tui/commands.js';
import { TuiSessionController } from '../src/tui/controller.js';
import type { TuiDialogHost } from '../src/tui/dialogs.js';
import { snapshot } from './client-fixtures.js';

afterEach(() => { vi.restoreAllMocks(); });
const operations: Operation[] = ['remote.status', 'remote.configure', 'session.remote', 'host.status'];
const status: RemoteStatus = { configured: true, share: 'on-request', state: 'connected', apiUrl: 'https://app.felan.ai',
  host: { id: '12345678-1234-1234-1234-123456789abc' }, pending: 3, sessions: 2,
  projects: [{ id: 'project', name: 'Example', path: '/fixture' }] };

function fixture(options: { status?: Partial<RemoteStatus>; operations?: Operation[]; attached?: boolean; failure?: Response } = {}) {
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
  const submit = (text: string) => submitTuiInput(controller, dialogs, text, { cwd: '/wrong-fallback', exit() {} });
  return { controller, dialogs, request, submit };
}

describe('/remote', () => {
  it.each(['/remote', '/remote status'])('shows a compact status for %s without requiring a session', async text => {
    const f = fixture({ attached: false, status: { state: 'stopped', reason: 'unsupported_schema', message: 'Update Felan to resume sharing.', supported: { protocol: [1], rowSchemaVersion: [1] } } });
    expect(await f.submit(text)).toBe(true);
    expect(f.request).toHaveBeenCalledExactlyOnceWith('remote.status', {}, {});
    expect(f.dialogs.select).toHaveBeenCalledWith('Remote stopped · unsupported_schema', expect.arrayContaining([
      { value: 'message', label: 'Update Felan to resume sharing.' },
      { value: 'host', label: 'Host: 12345678 · PAT configured' },
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

  it.each([undefined, 'http://localhost:3000'])('collects a PAT only via masked input (apiUrl: %s)', async apiUrl => {
    const f = fixture({ attached: false }); const token = 'fln_pat_synthetic';
    vi.mocked(f.dialogs.input).mockResolvedValueOnce(` ${token} `);
    expect(await f.submit(`/remote login${apiUrl ? ` ${apiUrl}` : ''}`)).toBe(true);
    expect(f.dialogs.input).toHaveBeenCalledExactlyOnceWith('Felan personal access token', '', { secret: true });
    expect(f.request).toHaveBeenCalledExactlyOnceWith('remote.configure', { action: 'login', token, ...(apiUrl ? { apiUrl } : {}) }, {});
    expect(JSON.stringify(f.controller.notes)).not.toContain(token); expect(f.controller.notice).not.toContain(token);
    expect(f.controller.history).toEqual([]);
  });

  it.each([undefined, '', 'wrong-prefix', 'fln_pat_', 'fln_pat_with space', `fln_pat_${'x'.repeat(510)}`])('does not send cancelled or malformed PAT input (%s)', async token => {
    const f = fixture(); vi.mocked(f.dialogs.input).mockResolvedValueOnce(token);
    expect(await f.submit('/remote login')).toBe(false); expect(f.request).not.toHaveBeenCalled();
    if (token !== undefined) expect(f.controller.notice).toContain('beginning with fln_pat_');
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

  it('reports stopped login results and remote needs in daemon status', async () => {
    const f = fixture({ status: { state: 'stopped', reason: 'invalid_pat', message: 'Felan rejected the access token; run /remote login' } });
    vi.mocked(f.dialogs.input).mockResolvedValueOnce('fln_pat_synthetic');
    expect(await f.submit('/remote login')).toBe(true); expect(f.controller.notice).toContain('Felan rejected the access token; run /remote login');
    f.request.mockResolvedValueOnce({ outcome: 'accepted', result: { daemonVersion: 'fixture', state: 'ready', active: { sessions: 1, runs: 0, work: 0, attachments: 1 },
      setupNeeds: [{ code: 'remote', message: 'Felan rejected the access token; run /remote login' }] } } as never);
    expect(await f.submit('/daemon status')).toBe(true);
    expect(f.dialogs.select).toHaveBeenCalledWith('Daemon fixture · ready', expect.arrayContaining([
      { value: 'remote', label: 'Remote: Felan rejected the access token; run /remote login' },
    ]));
  });
});
