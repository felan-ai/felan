import type { AutocompleteItem } from '@earendil-works/pi-tui';
import type { OperationParams, RemoteStatus } from '@felan-ai/session-protocol';
import type { TuiSessionController } from './controller.js';
import type { TuiDialogHost } from './dialogs.js';
import type { OpenBrowser } from './browser.js';

const usage = 'Usage: /remote [status|on|off|login [apiUrl]|logout|share all|on-request|open [name]|close]';
const completions = ['status', 'on', 'off', 'login', 'logout', 'share all', 'share on-request', 'open', 'close'];
const PAIRING_POLL_MS = 2_000;

type PairingInfo = NonNullable<RemoteStatus['pairing']>;

export function remoteCompletions(prefix: string): AutocompleteItem[] {
  return completions.filter(value => value.startsWith(prefix)).map(value => ({ value, label: value }));
}

export function remoteHistoryInput(text: string): string {
  return /^\/remote\s+login(?:\s|$)/u.test(text.trim()) ? '/remote login' : text;
}

export async function submitRemoteInput(controller: TuiSessionController, dialogs: TuiDialogHost, argument: string, openBrowser: OpenBrowser): Promise<boolean> {
  if (!(['remote.status', 'remote.configure', 'session.remote'] as const).every(op => controller.client.capabilities?.operations.includes(op))) {
    controller.setNotice('Remote sessions are not available from this daemon'); return false;
  }
  const [, action = 'status', rest = ''] = /^(\S+)(?:\s+([\s\S]*))?$/u.exec(argument.trim()) ?? [];
  if (!completions.some(value => value.split(' ')[0] === action) || !['login', 'share', 'open'].includes(action) && rest) {
    controller.setNotice(usage); return false;
  }
  if (action === 'status') {
    const response = await controller.perform('remote.status', {});
    if (response.outcome !== 'accepted') return false;
    await showStatus(dialogs, response.result); return true;
  }
  if (action === 'on' || action === 'off') {
    const session = requireSession(controller);
    const status = action === 'on' ? await controller.perform('remote.status', {}) : undefined;
    if (status && status.outcome !== 'accepted') return false;
    if ((await controller.perform('session.remote', { shared: action === 'on' }, session)).outcome !== 'accepted') return false;
    controller.setNotice(action === 'off' ? 'Stopped sharing this session. Already shared history stays on Felan.'
      : `Sharing this session with Felan${status?.outcome === 'accepted' && !status.result.configured ? '. Sharing starts after /remote login.' : ''}`);
    return true;
  }
  if (action === 'login') {
    if (rest && !validApiUrl(rest)) { controller.setNotice('Usage: /remote login [http(s)://apiUrl]'); return false; }
    const response = await controller.perform('remote.configure', { action: 'login', ...(rest ? { apiUrl: rest } : {}) });
    if (response.outcome !== 'accepted') return false;
    if (!response.result.pairing) { controller.setNotice(statusNotice('Felan login saved', response.result)); return true; }
    return awaitPairing(controller, dialogs, response.result.pairing, openBrowser);
  }
  let params: OperationParams<'remote.configure'>;
  let notice: string;
  if (action === 'logout') {
    params = { action: 'logout' }; notice = 'Logged out of Felan. Already shared history stays on Felan.';
  } else if (action === 'share') {
    if (rest !== 'all' && rest !== 'on-request') { controller.setNotice(usage); return false; }
    params = { action: 'share', share: rest };
    notice = rest === 'all' ? 'Sharing all sessions with Felan' : 'Sharing sessions on request. Use /remote on to share a session.';
  } else {
    requireSession(controller);
    const cwd = controller.snapshot?.cwd;
    if (!cwd) throw new Error('Session is not ready.');
    if (action === 'open') {
      params = { action: 'open_project', path: cwd, ...(rest ? { name: rest } : {}) };
      notice = 'Opened this directory as a remote project on Felan.';
    } else {
      const response = await controller.perform('remote.status', {});
      if (response.outcome !== 'accepted') return false;
      const project = response.result.projects.find(project => project.path === cwd);
      if (!project) { controller.setNotice('No remote project is open for this directory.'); return false; }
      params = { action: 'close_project', id: project.id }; notice = 'Closed the remote project for this directory.';
    }
  }
  const response = await controller.perform('remote.configure', params);
  if (response.outcome !== 'accepted') return false;
  controller.setNotice(statusNotice(notice, response.result)); return true;
}

// The browser open is best-effort: the code and URL stay on screen whether or not a browser launches.
async function awaitPairing(controller: TuiSessionController, dialogs: TuiDialogHost, pairing: PairingInfo, openBrowser: OpenBrowser): Promise<boolean> {
  const dismiss = new AbortController();
  let finished = false;
  let cancelled = false;
  const prompt = dialogs.select(`Approve this machine on Felan\n\nCode: ${pairing.userCode}\nOpen: ${pairing.verificationUriComplete}`,
    [{ value: 'cancel', label: 'Cancel pairing' }], { signal: dismiss.signal })
    .then(() => { if (!finished) cancelled = true; });
  void Promise.resolve().then(() => openBrowser(pairing.verificationUriComplete)).catch(() => {});
  let status: RemoteStatus | undefined;
  try {
    while (!cancelled) {
      await Promise.race([new Promise<void>(resolve => setTimeout(resolve, PAIRING_POLL_MS)), prompt]);
      if (cancelled) break;
      const response = await controller.perform('remote.status', {});
      if (response.outcome !== 'accepted') { controller.setNotice('Felan login status is unavailable. Run /remote status to check it.'); return false; }
      if (!response.result.pairing && response.result.state !== 'connecting') status = response.result;
      if (status) break;
    }
  } finally { finished = true; dismiss.abort(); await prompt; }
  if (!status) {
    const response = await controller.perform('remote.configure', { action: 'cancel_pairing' });
    if (response.outcome === 'accepted') {
      const result = response.result;
      controller.setNotice(result.message ? statusNotice('Felan login', result)
        : result.configured ? 'Felan login cancelled · reconnecting with the existing pairing' : 'Felan login cancelled.');
    }
    return false;
  }
  if (status.state === 'stopped') { controller.setNotice(statusNotice('Felan login not completed', status)); return false; }
  controller.setNotice(status.state === 'connected' ? 'Felan login saved · this machine is paired' : statusNotice('Felan login saved', status));
  return true;
}

function requireSession(controller: TuiSessionController): string {
  if (!controller.sessionId) throw new Error('No session is attached. Use /new or /sessions.');
  return controller.sessionId;
}

function validApiUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !!url.hostname && !url.username && !url.password
      && !/[\\\s\u0000-\u001f\u007f-\u009f]/u.test(value) && !value.includes('fln_pat_');
  } catch { return false; }
}

function statusNotice(notice: string, status: RemoteStatus): string {
  if (status.message) return `${notice} · ${status.message}`;
  if (status.reason) return `${notice} · ${status.state}: ${status.reason}`;
  return !status.configured && status.share === 'all' ? `${notice}. Sharing starts after /remote login.` : notice;
}

async function showStatus(dialogs: TuiDialogHost, status: RemoteStatus): Promise<void> {
  await dialogs.select(`Remote ${status.state}${status.reason ? ` · ${status.reason}` : ''}`, [
    ...(status.message ? [{ value: 'message', label: status.message }] : []),
    { value: 'host', label: `Host: ${status.host?.id.slice(0, 8) ?? 'not registered'} · ${status.configured ? 'paired' : 'not paired'}` },
    { value: 'share', label: `Share: ${status.share}` },
    { value: 'summary', label: `${status.pending} pending events · ${status.sessions} shared sessions` },
    ...status.projects.map(project => ({ value: project.id, label: `Project: ${project.name} · ${project.path}` })),
    ...(!status.projects.length ? [{ value: 'projects', label: 'No remote projects open' }] : []),
    { value: 'api', label: `API: ${status.apiUrl}` },
    ...(status.supported ? [{ value: 'supported', label: `Supported protocol: ${status.supported.protocol.join(', ')} · row schema: ${status.supported.rowSchemaVersion.join(', ')}` }] : []),
  ]);
}
