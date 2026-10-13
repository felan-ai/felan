import { afterEach, describe, expect, it, vi } from 'vitest';
import backgroundBash, { BackgroundBashManager, type BackgroundBashJob } from '../../../packages/ext-background-bash/src/extension.js';
import { splitProcessLog } from '../../../packages/ext-background-bash/src/data.js';
import { clientRoute, commitAction, extensionFixture } from './generic-extension-ui-fixtures.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  try { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); }
  finally { vi.restoreAllMocks(); }
});

function job(index: number): BackgroundBashJob {
  const meta = { id: `job-${index}`, command: `printf 'Unicode λ ${index}'`, cwd: '/private-workspace', jobDir: '/private-job',
    logPath: '/private-log', infoPath: '/private-info', completionPath: '/private-completion', commandPath: '/private-command',
    runnerPath: '/private-runner', shell: 'sh', shellArgs: [], startedAt: 1000, creatorPid: 42, pid: 99,
    processToken: 'private-token', executionMode: 'pty' as const };
  const status = { id: meta.id, status: 'running' as const, startedAt: 1000, updatedAt: 2000 };
  return { meta, status, info: { ...meta, ...status } };
}

async function fixture() {
  const h = extensionFixture();
  let jobs = Array.from({ length: 20 }, (_, index) => job(index + 1));
  const shell = vi.fn(async () => ({ code: 0, killed: false, stdout: '', stderr: '' }));
  Object.assign(h.api.runtime, { shell });
  Object.assign(h.api, { setActiveTools: vi.fn(), sendMessage: vi.fn() });
  vi.spyOn(BackgroundBashManager.prototype, 'list').mockImplementation(async () => jobs);
  const tail = vi.spyOn(BackgroundBashManager.prototype, 'tail').mockResolvedValue('bounded process output');
  const write = vi.spyOn(BackgroundBashManager.prototype, 'writeInteractive').mockResolvedValue({ id: 'job-1', running: true, output: '', nextOffset: 0,
    process: { pid: 99, read: async () => { throw new Error('Unexpected process read'); }, write: vi.fn(async () => {}),
      terminate: vi.fn(async () => {}), dispose: vi.fn(async () => {}) } });
  const stop = vi.spyOn(BackgroundBashManager.prototype, 'stop').mockImplementation(async id => {
    jobs = jobs.map(value => value.meta.id === id ? { ...value, status: { ...value.status, status: 'killed' } } : value);
    return jobs.find(value => value.meta.id === id)!;
  });
  const shutdown = vi.spyOn(BackgroundBashManager.prototype, 'shutdownInteractive').mockResolvedValue();
  cleanups.push(() => h.emit('session_shutdown'));
  await h.install(backgroundBash);
  await h.emit('session_start');
  await h.command('processes');
  return { ...h, shell, tail, write, stop, shutdown };
}

function route(kind: 'tui' | 'acp', row: ReturnType<typeof extensionFixture>['elements'][number]) {
  const client = clientRoute(kind, row.value);
  cleanups.push(() => client.dispose());
  return client;
}

async function action(kind: 'tui' | 'acp', row: ReturnType<typeof extensionFixture>['elements'][number],
  plan: Parameters<ReturnType<typeof clientRoute>['answer']>[0]) {
  const client = route(kind, row);
  await vi.waitFor(() => expect(client.dialogs).toHaveLength(1));
  client.answer(plan);
  await vi.waitFor(() => expect(client.pending).toHaveLength(1));
  const sent = client.pending[0]!.params;
  await client.accept(params => commitAction(row, params));
  await client.dispose();
  return sent;
}

describe.each(['tui', 'acp'] as const)('default Background Bash through a no-hint %s client', kind => {
  it('pages real process rows and output using only generic view/document actions', async () => {
    const h = await fixture();
    expect(h.context.hasUI).toBe(false);
    expect(h.shell).toHaveBeenCalledOnce();
    expect(h.api.registerShortcut).toHaveBeenCalledWith('ctrl+shift+j', expect.any(Object));
    expect(h.tools.has('bash')).toBe(true);
    expect(h.tools.has('write_background_bash')).toBe(true);
    const list = h.elements[0]!;
    expect(list.value).toMatchObject({ kind: 'view', items: expect.any(Array) });
    if (list.value.kind !== 'view') throw new Error('Expected process list.');
    expect(list.value.items).toHaveLength(18);
    const wire = JSON.stringify(list.value);
    expect(wire).toContain('Unicode λ');
    for (const secret of ['private-token', 'private-workspace', 'private-log', 'creatorPid', 'presenter', '"hint"']) expect(wire).not.toContain(secret);
    await action(kind, list, { actionId: 'next' });
    if (list.value.kind !== 'view') throw new Error('Expected process list.');
    expect(list.value.items.map(item => item.id)).toEqual(['job-19', 'job-20']);
    const output = `first line\n${'x'.repeat(60_000)}\nlast line`;
    const chunks = splitProcessLog(output);
    h.tail.mockResolvedValue(output);
    await action(kind, list, { actionId: 'read', itemId: 'job-20' });
    const document = h.elements.at(-1)!;
    expect(document.value).toMatchObject({ kind: 'document', fallback: expect.stringContaining(`page ${chunks.length} of ${chunks.length}`),
      markdown: expect.stringContaining('last line') });
    for (let index = chunks.length - 2; index >= 0; index--) await action(kind, document, { actionId: 'previous-output' });
    expect(document.value).toMatchObject({ markdown: expect.stringContaining('first line') });
    expect(h.tail).toHaveBeenCalledOnce();
    expect(h.tail).toHaveBeenCalledWith('job-20', 2000);
    await action(kind, document, { actionId: 'list' });
    expect(document.closed).toBe(true);
    await action(kind, list, { actionId: 'close' });
    await vi.waitFor(() => expect(list.closed).toBe(true));
  });

  it('forwards exact stdin and a single stop only after canonical client-action admission', async () => {
    const h = await fixture();
    await action(kind, h.elements[0]!, { actionId: 'read', itemId: 'job-1' });
    const document = h.elements.at(-1)!;
    const stdin = '\u0003exact text\n';
    const client = route(kind, document);
    await vi.waitFor(() => expect(client.dialogs).toHaveLength(1));
    client.answer({ actionId: 'write', values: { chars: stdin } });
    await vi.waitFor(() => expect(client.pending).toHaveLength(1));
    expect(h.write).not.toHaveBeenCalled();
    await client.accept(params => commitAction(document, params));
    expect(h.write).toHaveBeenCalledExactlyOnceWith('job-1', stdin);
    await client.dispose();
    const stale = await action(kind, document, { actionId: 'stop' });
    expect(h.stop).toHaveBeenCalledExactlyOnceWith('job-1', 'SIGTERM');
    if (document.value.kind !== 'document') throw new Error('Expected process output.');
    expect(document.value.actions.some(item => ['stop', 'kill', 'write'].includes(item.id))).toBe(false);
    await expect(commitAction(document, stale)).rejects.toThrow();
    expect(h.stop).toHaveBeenCalledOnce();
  });

  it('does not signal after rejected admission or shutdown, and closes all published elements', async () => {
    const h = await fixture();
    await action(kind, h.elements[0]!, { actionId: 'read', itemId: 'job-1' });
    const document = h.elements.at(-1)!;
    const client = route(kind, document);
    await vi.waitFor(() => expect(client.dialogs).toHaveLength(1));
    client.answer({ actionId: 'kill' });
    await vi.waitFor(() => expect(client.pending).toHaveLength(1));
    const stale = client.pending[0]!.params;
    client.pending[0]!.reply(false);
    await vi.waitFor(() => expect(client.report).toHaveBeenCalledOnce());
    expect(h.stop).not.toHaveBeenCalled();
    await h.emit('session_shutdown');
    expect(h.elements.every(row => row.closed)).toBe(true);
    await expect(commitAction(document, stale)).rejects.toThrow('closed');
    expect(h.stop).not.toHaveBeenCalled();
    expect(h.shutdown).toHaveBeenCalledOnce();
  });

  it('preserves process data without offering controls when action capability is absent', async () => {
    const h = await fixture();
    const client = clientRoute(kind, h.elements[0]!.value, ['ui.view', 'ui.document']);
    cleanups.push(() => client.dispose());
    await vi.waitFor(() => expect(client.displays.length + client.send.mock.calls.length).toBeGreaterThan(0));
    expect(JSON.stringify([client.displays, client.send.mock.calls])).toContain('Unicode λ');
    expect(client.dialogs).toHaveLength(0);
    expect(client.pending).toHaveLength(0);
    expect(h.tail).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
    expect(h.stop).not.toHaveBeenCalled();
  });
});
