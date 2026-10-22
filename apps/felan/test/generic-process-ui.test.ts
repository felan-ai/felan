import { afterEach, describe, expect, it, vi } from 'vitest';
import backgroundBash, { BackgroundBashManager, type BackgroundBashJob } from '../../../packages/ext-background-bash/src/extension.js';
import { splitProcessLog } from '../../../packages/ext-background-bash/src/data.js';
import { BACKGROUND_BASH_SCAN_LIMIT } from '../../../packages/ext-background-bash/src/job-store.js';
import { clientRoute, commitAction, extensionFixture } from './generic-extension-ui-fixtures.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  try { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); }
  finally { vi.restoreAllMocks(); }
});

function job(index: number): BackgroundBashJob {
  const meta = { id: `job-${index}`, command: `printf 'Unicode λ ${index}'`, cwd: '/private-workspace', jobDir: '/private-job',
    logPath: '/private-log', infoPath: '/private-info', completionPath: '/private-completion', commandPath: '/private-command',
    runnerPath: '/private-runner', shell: 'sh', shellArgs: [], startedAt: 1000 + index, creatorPid: 42, pid: 99,
    processToken: 'private-token', executionMode: 'pty' as const };
  const status = { id: meta.id, status: 'running' as const, startedAt: meta.startedAt, updatedAt: 2000 };
  return { meta, status, info: { ...meta, ...status } };
}

async function fixture(count = 20) {
  const h = extensionFixture();
  let jobs = Array.from({ length: count }, (_, index) => job(count - index));
  const shell = vi.fn(async () => ({ code: 0, killed: false, stdout: '', stderr: '' }));
  Object.assign(h.api.runtime, { shell });
  Object.assign(h.api, { setActiveTools: vi.fn(), sendMessage: vi.fn() });
  const list = vi.spyOn(BackgroundBashManager.prototype, 'list').mockRejectedValue(new Error('Unexpected unbounded process list'));
  const query = vi.spyOn(BackgroundBashManager.prototype, 'query').mockImplementation(async (options = {}) => {
    const candidates = jobs.slice(options.cursor ? jobs.findIndex(value => value.meta.id === options.cursor) + 1 : 0);
    const rows: BackgroundBashJob[] = [];
    const search = options.search?.trim().toLowerCase();
    let scanned = 0;
    for (const candidate of candidates) {
      scanned++;
      if ((!options.status || options.status === 'all' || candidate.status.status === options.status)
        && (!search || `${candidate.meta.id}\n${candidate.meta.command}`.toLowerCase().includes(search))) rows.push(candidate);
      if (rows.length === (options.limit ?? 10) || scanned === BACKGROUND_BASH_SCAN_LIMIT) break;
    }
    const hasMore = scanned < candidates.length;
    return { jobs: rows, scanned, hasMore, ...(hasMore ? { nextCursor: candidates[scanned - 1]!.meta.id } : {}) };
  });
  const tail = vi.spyOn(BackgroundBashManager.prototype, 'tail').mockResolvedValue('bounded process output');
  const write = vi.spyOn(BackgroundBashManager.prototype, 'writeInteractive').mockResolvedValue({ id: 'job-1', running: true, output: '', nextOffset: 0,
    process: { pid: 99, read: async () => { throw new Error('Unexpected process read'); }, write: vi.fn(async () => {}),
      terminate: vi.fn(async () => {}), dispose: vi.fn(async () => {}) } });
  const stop = vi.spyOn(BackgroundBashManager.prototype, 'stop').mockImplementation(async id => {
    jobs = jobs.map(value => value.meta.id === id
      ? { ...value, status: { ...value.status, status: 'killed' }, info: { ...value.info, status: 'killed' } } : value);
    return jobs.find(value => value.meta.id === id)!;
  });
  const shutdown = vi.spyOn(BackgroundBashManager.prototype, 'shutdownInteractive').mockResolvedValue();
  cleanups.push(() => h.emit('session_shutdown'));
  await h.install(backgroundBash);
  await h.emit('session_start');
  await h.command('processes');
  return { ...h, shell, list, query, tail, write, stop, shutdown };
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
    expect(h.query).toHaveBeenCalledExactlyOnceWith({ limit: 10 });
    expect(h.list).not.toHaveBeenCalled();
    expect(list.value.title).toContain('Recent processes');
    expect(list.value.items.map(item => item.id)).toEqual(Array.from({ length: 10 }, (_, index) => `job-${20 - index}`));
    expect(list.value.paging).toBeUndefined();
    expect(list.value.actions.some(item => item.id === 'next')).toBe(false);
    const wire = JSON.stringify(list.value);
    expect(wire).toContain('Unicode λ');
    for (const secret of ['private-token', 'private-workspace', 'private-log', 'creatorPid', 'presenter', '"hint"']) expect(wire).not.toContain(secret);
    await action(kind, list, { actionId: 'history' });
    expect(h.query).toHaveBeenCalledTimes(2);
    expect(h.query).toHaveBeenLastCalledWith({ limit: 10 });
    expect(list.value.title).toContain('Process history');
    expect(list.value.paging).toEqual({ nextActionId: 'next' });
    await action(kind, list, { actionId: 'next' });
    if (list.value.kind !== 'view') throw new Error('Expected process list.');
    expect(h.query).toHaveBeenLastCalledWith({ limit: 10, cursor: 'job-11' });
    expect(list.value.items.map(item => item.id)).toEqual(Array.from({ length: 10 }, (_, index) => `job-${10 - index}`));
    expect(list.value.paging).toEqual({ previousActionId: 'previous' });
    await action(kind, list, { actionId: 'previous' });
    expect(h.query).toHaveBeenLastCalledWith({ limit: 10 });
    await action(kind, list, { actionId: 'next' });
    const output = `first line\n${'x'.repeat(60_000)}\nlast line`;
    const chunks = splitProcessLog(output);
    h.tail.mockResolvedValue(output);
    await action(kind, list, { actionId: 'read', itemId: 'job-1' });
    const document = h.elements.at(-1)!;
    expect(document.value).toMatchObject({ kind: 'document', fallback: expect.stringContaining(`page ${chunks.length} of ${chunks.length}`),
      markdown: expect.stringContaining('last line') });
    for (let index = chunks.length - 2; index >= 0; index--) await action(kind, document, { actionId: 'previous-output' });
    expect(document.value).toMatchObject({ markdown: expect.stringContaining('first line') });
    expect(h.tail).toHaveBeenCalledOnce();
    expect(h.tail).toHaveBeenCalledWith('job-1', 2000);
    await action(kind, document, { actionId: 'list' });
    expect(document.closed).toBe(true);
    await action(kind, list, { actionId: 'recent' });
    expect(list.value.title).toContain('Recent processes');
    expect(list.value.paging).toBeUndefined();
    expect(h.query).toHaveBeenLastCalledWith({ limit: 10 });
    expect(h.list).not.toHaveBeenCalled();
    await action(kind, list, { actionId: 'close' });
    await vi.waitFor(() => expect(list.closed).toBe(true));
  });

  it('searches all history only on submission and explicitly advances bounded scan batches', async () => {
    const h = await fixture(120);
    const list = h.elements[0]!;
    if (list.value.kind !== 'view') throw new Error('Expected process list.');
    expect(list.value.query).toEqual({ actionId: 'search', values: { query: '' } });
    const client = route(kind, list);
    await vi.waitFor(() => expect(client.dialogs).toHaveLength(1));
    client.answer({ actionId: 'search', values: { query: "  UNICODE λ 1'  " } });
    await vi.waitFor(() => expect(client.pending).toHaveLength(1));
    expect(h.query).toHaveBeenCalledExactlyOnceWith({ limit: 10 });
    await client.accept(params => commitAction(list, params));
    await client.dispose();
    expect(h.query).toHaveBeenCalledTimes(2);
    expect(h.query).toHaveBeenLastCalledWith({ limit: 10, search: "UNICODE λ 1'" });
    expect(list.value.items).toEqual([]);
    expect(list.value.fallback).toContain('100 records scanned');
    expect(list.value.fallback).toContain('No matches in this batch; more history remains.');
    expect(list.value.actions.find(item => item.id === 'next')?.label).toBe('Continue scanning');
    await action(kind, list, { actionId: 'next' });
    expect(h.query).toHaveBeenCalledTimes(3);
    expect(h.query).toHaveBeenLastCalledWith({ limit: 10, cursor: 'job-21', search: "UNICODE λ 1'" });
    expect(list.value.items.map(item => item.id)).toEqual(['job-1']);
    expect(list.value.fallback).toContain('120 records scanned');
    expect(list.value.paging).toEqual({ previousActionId: 'previous' });
    await action(kind, list, { actionId: 'search', values: { query: '' } });
    expect(h.query).toHaveBeenLastCalledWith({ limit: 10 });
    expect(list.value.title).toContain('Process history');
    expect(list.value.items[0]?.id).toBe('job-120');
    await action(kind, list, { actionId: 'recent' });
    expect(list.value.query).toEqual({ actionId: 'search', values: { query: '' } });
    expect(list.value.paging).toBeUndefined();
    expect(h.list).not.toHaveBeenCalled();
  });

  it('forwards exact stdin and a single stop only after canonical client-action admission', async () => {
    const h = await fixture();
    await action(kind, h.elements[0]!, { actionId: 'read', itemId: 'job-20' });
    const document = h.elements.at(-1)!;
    const stdin = '\u0003exact text\n';
    const client = route(kind, document);
    await vi.waitFor(() => expect(client.dialogs).toHaveLength(1));
    client.answer({ actionId: 'write', values: { chars: stdin } });
    await vi.waitFor(() => expect(client.pending).toHaveLength(1));
    expect(h.write).not.toHaveBeenCalled();
    await client.accept(params => commitAction(document, params));
    expect(h.write).toHaveBeenCalledExactlyOnceWith('job-20', stdin);
    expect(h.query).toHaveBeenCalledWith({ limit: 10, search: 'job-20' });
    await client.dispose();
    const stale = await action(kind, document, { actionId: 'stop' });
    expect(h.stop).toHaveBeenCalledExactlyOnceWith('job-20', 'SIGTERM');
    if (document.value.kind !== 'document') throw new Error('Expected process output.');
    expect(document.value.actions.some(item => ['stop', 'kill', 'write'].includes(item.id))).toBe(false);
    await expect(commitAction(document, stale)).rejects.toThrow();
    expect(h.stop).toHaveBeenCalledOnce();
  });

  it('does not signal after rejected admission or shutdown, and closes all published elements', async () => {
    const h = await fixture();
    await action(kind, h.elements[0]!, { actionId: 'read', itemId: 'job-20' });
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

  it.each([false, true])('reopens after semantic close with changed process data: %s', async changed => {
    const h = await fixture();
    const first = h.elements[0]!;
    await action(kind, first, { actionId: 'close' });
    await vi.waitFor(() => expect(first.closed).toBe(true));
    if (changed) await h.stop('job-20', 'SIGTERM');
    await h.command('processes');
    const reopened = h.elements.at(-1)!;
    expect(reopened.value.id).not.toBe(first.value.id);
    expect(reopened.closed).toBe(false);
    expect(reopened.value.kind).toBe('view');
    if (reopened.value.kind !== 'view') throw new Error('Expected process list.');
    expect(reopened.value.items[0]?.values.status).toBe(changed ? 'killed' : 'running');
    await action(kind, reopened, { actionId: 'close' });
    await vi.waitFor(() => expect(reopened.closed).toBe(true));
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
