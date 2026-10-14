import { client, methods } from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcpSessionRegistry } from '../src/acp/session-registry.js';
import { createFelanAcpService } from '../src/acp/server.js';
import { gate } from '../../daemon/test/fixtures/server.js';
import { acpDaemonFixture } from './acp-daemon-fixture.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(options: Parameters<typeof acpDaemonFixture>[0] = {}) {
  const f = await acpDaemonFixture(options);
  cleanups.push(() => f.dispose());
  const registry = new AcpSessionRegistry({ createClient: f.createClient });
  cleanups.push(() => registry.dispose());
  registry.initialize({ elicitation: { form: {} } });
  return { ...f, sessions: registry };
}
const request = (cwd: string) => ({ cwd, mcpServers: [] });

describe('daemon ACP sessions', () => {
  it('advertises only implemented capabilities and retains terminal-auth negotiation', async () => {
    const service = createFelanAcpService();
    cleanups.push(() => service.dispose());
    await client({ name: 'test' }).connectWith(service.app, async connection => {
      const initialized = await connection.request(methods.agent.initialize, { protocolVersion: 1,
        clientCapabilities: { auth: { terminal: true } } });
      expect(initialized.agentCapabilities).toEqual({ loadSession: true, sessionCapabilities: { close: {} } });
      expect(initialized.authMethods?.[0]?.id).toBe('felan-terminal-login');
    });
  });

  it('creates and attaches daemon sessions with the strict policy and ignores client MCP servers', async () => {
    const f = await fixture();
    const { sessionId } = await f.sessions.newSession({ ...request(f.cwd), mcpServers: [{ name: 'ignored', command: 'never-run', args: [], env: [] }] }, f.editor);
    const stored = f.store.session(sessionId);
    expect(stored.policy.effective).toBe('acp-strict');
    expect(f.clients[0]!.getAttachment(sessionId)?.state.status).toBe('live');
    expect(await f.sessions.prompt({ sessionId, prompt: [{ type: 'text', text: 'hello' }] }, f.editor)).toEqual({ stopReason: 'end_turn' });
    expect(f.updates.some(item => item.update.sessionUpdate === 'agent_message_chunk')).toBe(true);
    await f.sessions.closeSession({ sessionId });
    expect(f.store.session(sessionId).state).toBe('open');
  });

  it('replays persisted history and uses the same session ID when another editor loads', async () => {
    const f = await fixture();
    const { sessionId } = await f.sessions.newSession(request(f.cwd), f.editor);
    await f.sessions.prompt({ sessionId, prompt: [{ type: 'text', text: 'remember this' }] }, f.editor);
    await f.sessions.closeSession({ sessionId });
    f.updates.length = 0;
    await f.sessions.loadSession({ ...request(f.cwd), sessionId }, f.editor);
    const user = f.updates.filter(item => item.update.sessionUpdate === 'user_message_chunk');
    expect(JSON.stringify(user)).toContain('remember this');
    expect(f.store.session(sessionId).policy.effective).toBe('acp-strict');
    await expect(f.sessions.loadSession({ ...request(f.cwd), sessionId }, f.editor)).rejects.toThrow('already active');
  });

  it('rejects additional roots, relative paths, mismatched cwd, and unsupported prompt types', async () => {
    const f = await fixture();
    await expect(f.sessions.newSession(request('relative'), f.editor)).rejects.toThrow('absolute');
    await expect(f.sessions.newSession({ ...request(f.cwd), additionalDirectories: [f.directory] }, f.editor)).rejects.toThrow('Additional directories');
    await expect(f.sessions.loadSession({ ...request(f.directory), sessionId: f.root.sessionId }, f.editor)).rejects.toThrow('cwd');
    await f.sessions.loadSession({ ...request(f.cwd), sessionId: f.root.sessionId }, f.editor);
    await expect(f.sessions.prompt({ sessionId: f.root.sessionId, prompt: [{ type: 'image', data: '', mimeType: 'image/png' }] }, f.editor)).rejects.toThrow('Unsupported prompt');
  });

  it('detaches without cancelling an admitted prompt when an editor closes', async () => {
    const stream = gate();
    const f = await fixture({ onStream: () => stream.promise });
    cleanups.push(async () => stream.resolve());
    await f.sessions.loadSession({ ...request(f.cwd), sessionId: f.root.sessionId }, f.editor);
    const prompt = f.sessions.prompt({ sessionId: f.root.sessionId, prompt: [{ type: 'text', text: 'keep running' }] }, f.editor);
    const result = prompt.catch(error => error);
    await vi.waitFor(() => expect(f.store.session(f.root.sessionId).run.state).toBe('running'));
    await f.sessions.closeSession({ sessionId: f.root.sessionId });
    expect(f.store.session(f.root.sessionId).run.state).toBe('running');
    expect(f.store.session(f.root.sessionId).state).toBe('open');
    expect(await result).toBeInstanceOf(Error);
    stream.resolve();
  });

  it('explicit cancellation targets the admitted run and returns cancelled', async () => {
    const stream = gate();
    const f = await fixture({ onStream: () => stream.promise });
    cleanups.push(async () => stream.resolve());
    await f.sessions.loadSession({ ...request(f.cwd), sessionId: f.root.sessionId }, f.editor);
    const prompt = f.sessions.prompt({ sessionId: f.root.sessionId, prompt: [{ type: 'text', text: 'cancel me' }] }, f.editor);
    await vi.waitFor(() => expect(f.store.session(f.root.sessionId).run.state).toBe('running'));
    const cancelling = f.sessions.cancel(f.root.sessionId);
    stream.resolve();
    await cancelling;
    expect(await prompt).toEqual({ stopReason: 'cancelled' });
  });

  it('loads a busy session for observation and applies the strict ACP policy immediately', async () => {
    const stream = gate();
    const f = await fixture({ onStream: () => stream.promise });
    cleanups.push(async () => stream.resolve());
    const tui = f.createClient({ target: { kind: 'isolated', directory: f.directory, namespaceId: f.owner.target.namespaceId }, clientVersion: 'test', kind: 'tui' });
    await tui.connect(); await tui.attach(f.root.sessionId);
    const running = await tui.request('prompt', { text: 'already running' }, { session: f.root.sessionId });
    expect(running.outcome).toBe('accepted');
    await f.sessions.loadSession({ ...request(f.cwd), sessionId: f.root.sessionId }, f.editor);
    expect(f.store.session(f.root.sessionId).policy.effective).toBe('acp-strict');
    stream.resolve();
    await vi.waitFor(() => expect(f.store.session(f.root.sessionId).run.state).toBe('idle'));
    expect(await f.sessions.prompt({ sessionId: f.root.sessionId, prompt: [{ type: 'text', text: 'now' }] }, f.editor)).toEqual({ stopReason: 'end_turn' });
  });

  it('preserves pending approvals across EOF and lets a TUI resolve them', async () => {
    const f = await fixture();
    vi.mocked(f.editor.request).mockImplementation(() => new Promise(() => {}));
    await f.sessions.loadSession({ ...request(f.cwd), sessionId: f.root.sessionId }, f.editor);
    const waiting = f.broker.request({ kind: 'tool_approval', toolCallId: 'tool', toolName: 'external-read', summary: 'Needs permission',
      options: [{ id: 'allow-once', title: 'Allow once' }, { id: 'reject-once', title: 'Reject' }] },
    { kind: 'session', session: f.root.sessionId, root: f.root.sessionId });
    await vi.waitFor(() => expect(f.editor.request).toHaveBeenCalled());
    const id = f.broker.pending()[0]!.id;
    await f.sessions.dispose();
    expect(f.broker.pending()[0]?.id).toBe(id);
    const tui = f.createClient({ target: { kind: 'isolated', directory: f.directory, namespaceId: f.owner.target.namespaceId }, clientVersion: 'test', kind: 'tui', interactionKinds: ['tool_approval'] });
    await tui.connect(); await tui.attach(f.root.sessionId);
    expect((await tui.request('interaction.answer', { interactionId: id, answer: { kind: 'tool_approval', optionId: 'allow-once' } }, { session: f.root.sessionId })).outcome).toBe('accepted');
    expect(await waiting).toEqual({ state: 'answered', answer: { kind: 'tool_approval', optionId: 'allow-once' } });
  });

  it('translates primitive forms and leaves unsupported or disconnected requests pending', async () => {
    const f = await fixture();
    vi.mocked(f.editor.request).mockResolvedValue({ action: 'accept', content: { value: 'chosen' } } as never);
    await f.sessions.loadSession({ ...request(f.cwd), sessionId: f.root.sessionId }, f.editor);
    const answer = await f.broker.request({ kind: 'input', title: 'Name' }, { kind: 'session', session: f.root.sessionId, root: f.root.sessionId });
    expect(answer).toEqual({ state: 'answered', answer: { kind: 'input', text: 'chosen' } });
  });

  it('maps daemon authentication_required to ACP auth-required while allowing history loading', async () => {
    const f = await fixture();
    await f.sessions.loadSession({ ...request(f.cwd), sessionId: f.root.sessionId }, f.editor);
    const daemon = f.clients[0]!;
    vi.spyOn(daemon, 'request').mockResolvedValueOnce({ v: 1, re: 'auth', outcome: 'rejected',
      error: { code: 'authentication_required', message: 'Configure a model provider before creating a session', retryable: false } } as never);
    await expect(f.sessions.newSession(request(f.cwd), f.editor)).rejects.toMatchObject({ code: -32000 });
  });
});
