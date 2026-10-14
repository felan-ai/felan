import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, unlink, writeFile, rename, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { LIMITS, parseInteraction } from '@felan-ai/session-protocol';
import { acquireDaemonOwnership, type DaemonOwnership } from '../src/daemon/ownership.js';
import { DaemonControlStore, type ControlStoreOptions } from '../src/daemon/control-store.js';
import type { PersistenceBoundary } from '../src/daemon/persistence.js';

const supported = ['darwin', 'linux'].includes(process.platform);
const roots: string[] = [];
const owners: DaemonOwnership[] = [];
const stores: DaemonControlStore[] = [];
const children: ChildProcess[] = [];
const now = 1_800_000_000_000;
function requestId(timestamp = now): string {
  const hex = timestamp.toString(16).padStart(12, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8)}-7${randomUUID().slice(1, 4)}-8${randomUUID().slice(1, 4)}-${randomUUID().slice(-12)}`;
}
async function target() { const directory = await mkdtemp(join(tmpdir(), 's104-')); roots.push(directory); return { kind: 'isolated' as const, directory, namespaceId: randomUUID() }; }
async function open(options: ControlStoreOptions = {}) {
  const input = await target(); const owner = await acquireDaemonOwnership(input); owners.push(owner);
  const store = new DaemonControlStore(owner, { now: () => now, ...options }); stores.push(store);
  store.createSession({ id: 's', root: 's', cwd: '/fixture', piPath: join(owner.target.agentDir, 's.jsonl'), state: 'open', residency: 'warm', run: { state: 'idle' }, policy: { effective: 'host-default', generation: 0 }, title: '' });
  return { owner, store, input };
}
function reopen(owner: DaemonOwnership, options: ControlStoreOptions = {}) { const store = new DaemonControlStore(owner, { now: () => now, ...options }); stores.push(store); return store; }
const prompt = (id = requestId(), text = 'offline') => ({ v: 1, id, op: 'prompt', session: 's', params: { text } });
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
  }
  for (const store of stores.splice(0)) store.close();
  for (const owner of owners.splice(0)) await owner.release();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe.skipIf(!supported)('bounded daemon control persistence', () => {
  it('commits a retry identity, dispatch intent and exact outcome before returning; reload preserves them', async () => {
    const { owner, store } = await open(); const request = prompt();
    expect(store.admit(request, 'owner').value.phase).toBe('intent');
    expect(store.admit({ ...request, ignored: 'secret-extra', params: { ...request.params, ignored: 'extra' } }, 'owner').value.phase).toBe('intent');
    expect(() => store.admit({ ...request, params: { text: 'different' } }, 'owner')).toThrow(/already used/);
    expect(() => store.admit(request, 'another-owner')).toThrow(/already used/);
    expect(() => store.finishRequest(request.id, { v: 1, re: request.id, outcome: 'accepted', result: { runId: 'r' } })).toThrow(/dispatch intent/);
    store.markDispatched(request.id);
    const response = { v: 1, re: request.id, outcome: 'accepted', result: { runId: 'r' } };
    store.finishRequest(request.id, response); store.close();
    const reloaded = reopen(owner); reloaded.recover();
    expect(reloaded.admit(request, 'owner').value.response).toEqual(response);
    expect(() => reloaded.markDispatched(request.id)).toThrow(/never dispatch/);
    expect(reloaded.session('s').revision).toBeGreaterThan(1);
    const bytes = await readFile(join(store.directory, 'control.json'), 'utf8');
    expect(bytes).not.toContain('offline'); expect(bytes).not.toContain('secret-extra');
  });
  it('stores large legal attachment identities as a digest, not unbounded copies or launch secrets', async () => {
    const { store } = await open();
    const request = { ...prompt(), params: { text: '', attachments: [{ type: 'image', mimeType: 'image/png', data: Buffer.alloc(7 * 1024 * 1024).toString('base64') }] }, env: { SECRET: 'launch-value' } };
    const record = store.admit(request, 'owner').value;
    expect(record.identity.bytes).toBeGreaterThan(9 * 1024 * 1024);
    expect((await readFile(join(store.directory, 'control.json'))).length).toBeLessThan(4096);
    expect(JSON.stringify(store.snapshot())).not.toContain('launch-value');
  });
  it('coalesces bounded tool/status projections, keeps revisions monotonic and advances policy generations', async () => {
    const { owner, store } = await open();
    for (let i = 0; i < 10; i++) store.project('s', [{ type: 'status', id: 'status', text: String(i) }, { type: 'tool', tool: { id: 'tool', name: 'fake', message: 'm', state: 'running', output: String(i), truncated: false } }]);
    expect(store.session('s').projections).toHaveLength(2);
    const revision = store.session('s').revision;
    store.updateSession('s', { policy: { effective: 'acp-strict', generation: 1 } });
    expect(() => store.updateSession('s', { policy: { effective: 'host-default', generation: 1 } })).toThrow(/advance/);
    store.updateSession('s', { policy: { effective: 'host-default', generation: 2 } });
    store.close(); const reloaded = reopen(owner);
    expect(() => reloaded.updateSession('s', { title: 'before recovery' })).toThrow(/Recover/);
    reloaded.recover(); expect(reloaded.session('s').revision).toBeGreaterThan(revision);
    expect(() => reloaded.recover()).toThrow(/only valid/);
    expect(reloaded.session('s').projections.find(item => item.value.type === 'tool')?.value).toMatchObject({ tool: { state: 'interrupted' } });
  });
  it('retains process identities but never recreates a PTY or foreground process', async () => {
    const { owner, store } = await open();
    for (const kind of ['pty', 'foreground', 'detached'] as const) store.putResource({ id: kind, session: 's', root: 's', kind, state: 'running', pid: 12345, startIdentity: 'fake-birth', reference: join(owner.target.agentDir, `${kind}.record`), updatedAt: now });
    store.close(); const reloaded = reopen(owner); const plan = reloaded.recover().value;
    expect(plan.reconcileDetached).toEqual(['detached']); expect(plan.missingResources).toEqual(['pty', 'foreground']);
    expect(reloaded.snapshot().resources.map(item => [item.id, item.state, item.pid])).toEqual([['pty', 'missing', 12345], ['foreground', 'missing', 12345], ['detached', 'reconciling', 12345]]);
    expect(() => reloaded.putResource({ ...reloaded.snapshot().resources[0], pid: 999 })).toThrow(/identity/);
  });
  for (const boundary of ['before_write', 'after_write', 'after_file_sync', 'before_rename', 'after_rename', 'after_directory_sync'] as PersistenceBoundary[]) {
    it(`fails closed and reloads an atomic snapshot when storage fails at ${boundary}`, async () => {
      let fail = false;
      const { owner, store } = await open({ fault: at => { if (fail && at === boundary) throw Object.assign(new Error('fake ENOSPC'), { code: 'ENOSPC' }); } });
      const initial = store.session('s').revision; fail = true;
      expect(() => store.updateSession('s', { title: 'committed-or-not' })).toThrow(/commit failed/);
      expect(() => store.admit(prompt(), 'owner')).toThrow(/fenced/);
      store.close(); const reloaded = reopen(owner); reloaded.recover();
      const afterRename = ['after_rename', 'after_directory_sync'].includes(boundary);
      expect(reloaded.session('s').title).toBe(afterRename ? 'committed-or-not' : '');
      expect(reloaded.session('s').revision).toBeGreaterThanOrEqual(initial);
    });
  }
  it('quarantines torn, deleted, unknown-format or replaced files and starts empty instead of restoring old revisions', async () => {
    for (const mode of ['torn', 'delete', 'version', 'symlink']) {
      const { owner, store } = await open(); store.close(); const path = join(store.directory, 'control.json');
      if (mode === 'torn') await writeFile(path, '{"torn":');
      if (mode === 'delete') await rm(path);
      if (mode === 'version') { const value = JSON.parse(await readFile(path, 'utf8')); value.version = 2; await writeFile(path, JSON.stringify(value)); }
      if (mode === 'symlink') { await rename(path, `${path}.old`); await symlink(`${path}.old`, path); }
      const reopened = reopen(owner);
      expect(reopened.snapshot().sessions).toEqual([]); expect(reopened.needsRecovery).toBe(false);
      reopened.close();
    }
  });
  it('rechecks ownership before writes and after injected scheduling gaps', async () => {
    let replace = false;
    const { owner, store } = await open({ fault: boundary => { if (replace && boundary === 'before_rename') throw new Error('ownership revoked'); } });
    replace = true; expect(() => store.updateSession('s', { title: 'lost' })).toThrow(/commit failed/);
    store.close(); await owner.release(); expect(() => store.snapshot()).toThrow();
  });
});

describe.skipIf(!supported)('real crashed-process recovery without execution replay', () => {
  for (const mode of ['intent', 'dispatch', 'effect', 'outcome', 'answer-ready', 'answer-intent', 'answer-effect', 'answer-completed', 'pi-content-first', 'pi-control-first', 'pi-both']) {
    it(`recovers ${mode} from actual SIGKILL persisted files`, async () => {
      const input = await target(); const id = requestId(Date.now());
      const child = spawn(process.execPath, [new URL('./fixtures/persistence-crash.mjs', import.meta.url).pathname, input.directory, input.namespaceId, id, mode], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH } });
      children.push(child);
      let stderr = ''; child.stderr.on('data', bytes => { stderr += String(bytes); });
      const [code, signal] = await once(child, 'exit'); expect({ code, signal, stderr }).toEqual({ code: null, signal: 'SIGKILL', stderr: '' });
      const owner = await acquireDaemonOwnership(input); owners.push(owner);
      const store = new DaemonControlStore(owner); stores.push(store); const before = store.session('session').revision;
      const plan = store.recover().value;
      expect(store.session('session').revision).toBeGreaterThan(before); expect(store.session('session').run.state).toBe('interrupted');
      if (mode.startsWith('answer')) {
        expect(store.snapshot().interactions[0]?.state).toBe('answered');
        expect(store.snapshot().interactions[0]).toMatchObject({ result: { kind: 'input', text: 'yes' } });
        expect(plan.resumableContinuations).toEqual(mode === 'answer-ready' ? ['continuation'] : []);
        expect(store.snapshot().continuations[0]?.phase).toBe(mode === 'answer-ready' ? 'ready' : mode === 'answer-completed' ? 'completed' : 'indeterminate');
      } else if (mode.startsWith('pi-')) {
        const contents = await readFile(join(owner.target.agentDir, 'session.jsonl'), 'utf8');
        store.reconcilePi('session', { present: contents.includes('"entry"') ? [{ id: 'message', entryId: 'entry' }] : [], absentEntryIds: contents.includes('"entry"') ? [] : ['entry'] });
        expect(store.session('session').projections[0]?.value).toMatchObject({ type: 'message', state: mode === 'pi-control-first' ? 'missing' : 'observed' });
      } else expect(store.snapshot().requests[0]?.response?.outcome).toBe(mode === 'intent' ? 'rejected' : mode === 'outcome' ? 'accepted' : 'indeterminate');
      const effects = await readFile(join(owner.target.agentDir, 'effects'), 'utf8').catch(() => '');
      expect(effects.split('\n').filter(Boolean)).toHaveLength(['effect', 'outcome', 'answer-effect'].includes(mode) ? 1 : 0);
    });
  }
});

describe.skipIf(!supported)('atomic interaction winners and continuation intents', () => {
  const answer = { kind: 'input' as const, text: 'yes' };
  function ask(createdAt = now) { return { id: 'ask', scope: { kind: 'session', session: 's', root: 's' }, request: { kind: 'input', title: 'Continue?' }, deferrable: true, state: 'waiting', createdAt }; }
  it('commits one answer, its request outcome, continuation and revision in a single snapshot', async () => {
    const { owner, store } = await open(); store.putInteraction(ask());
    const id = requestId(); store.admit({ v: 1, id, op: 'interaction.answer', session: 's', params: { interactionId: 'ask', answer } }, 'winner');
    const revision = store.session('s').revision;
    const result = store.answerInteraction(id, answer, 'continue');
    expect(result.revisions.s).toBe(revision + 1);
    expect(store.snapshot().requests[0]?.response?.outcome).toBe('accepted');
    expect(store.snapshot().continuations[0]?.phase).toBe('ready');
    const other = requestId(); store.admit({ v: 1, id: other, op: 'interaction.answer', session: 's', params: { interactionId: 'ask', answer } }, 'loser');
    expect(() => store.answerInteraction(other, answer, 'duplicate')).toThrow(/already resolved/);
    store.close(); const reloaded = reopen(owner); expect(reloaded.recover().value.resumableContinuations).toEqual(['continue']);
    expect(reloaded.snapshot().interactions[0]).toMatchObject({ state: 'answered', responder: 'winner', result: answer });
    reloaded.transitionContinuation('continue', 'dispatch_intent');
    expect(() => reloaded.transitionContinuation('continue', 'dispatch_intent')).toThrow(/twice/);
  });
  it('validates admitted answers before committing any winner or revision', async () => {
    const { store } = await open(); store.putInteraction(ask());
    const id = requestId(); store.admit({ v: 1, id, op: 'interaction.answer', session: 's', params: { interactionId: 'ask', answer } }, 'winner');
    const before = store.snapshot();
    expect(() => store.answerInteraction(id, { ...answer, text: 'no' }, 'continue')).toThrow(/differs/);
    expect(store.snapshot()).toEqual(before);
  });
  it('defers ask-user with a bounded default expiry, cancels nonreplayable waits and excludes OAuth secrets', async () => {
    const { owner, store } = await open(); store.putInteraction(ask());
    store.putInteraction({ id: 'approval', scope: { kind: 'session', session: 's', root: 's' }, request: { kind: 'confirm', title: 'Run tool?', message: '' }, state: 'waiting', createdAt: now });
    expect(() => store.putInteraction({ id: 'oauth', scope: { kind: 'host' }, request: { kind: 'oauth', provider: 'fake', url: 'https://invalid/?token=secret', instructions: '', provisioningId: 'fake' }, state: 'waiting', createdAt: now })).toThrow();
    store.close(); const reloaded = reopen(owner); reloaded.recover();
    expect(reloaded.snapshot().interactions[0]).toMatchObject({ state: 'deferred', expiresAt: now + 30 * 60 * 1000 });
    expect(reloaded.snapshot().interactions[1]).toMatchObject({ state: 'cancelled', result: { reason: 'restart' } });
  });
  for (const boundary of ['before_rename', 'after_rename'] as const) it(`preserves all-or-none answer state at ${boundary}`, async () => {
    let fail = false;
    const { owner, store } = await open({ fault: at => { if (fail && at === boundary) throw new Error('disk full'); } });
    store.putInteraction(ask()); const id = requestId(); store.admit({ v: 1, id, op: 'interaction.answer', session: 's', params: { interactionId: 'ask', answer } }, 'winner');
    fail = true; expect(() => store.answerInteraction(id, answer, 'continue')).toThrow(/commit failed/); store.close();
    const reloaded = reopen(owner); const plan = reloaded.recover().value;
    expect(plan.resumableContinuations).toEqual(boundary === 'after_rename' ? ['continue'] : []);
    expect(reloaded.snapshot().interactions[0]?.state).toBe(boundary === 'after_rename' ? 'answered' : 'deferred');
    expect(reloaded.snapshot().requests[0]?.response?.outcome).toBe(boundary === 'after_rename' ? 'accepted' : 'rejected');
  });
});

describe.skipIf(!supported)('control retention and cancellation boundaries', () => {
  it('advances revisions when compacting visible projections but never discards revision high-water', async () => {
    let time = now; const { owner, store } = await open({ now: () => time });
    store.project('s', [{ type: 'status', id: 'old', text: 'old status' }]);
    const before = store.session('s').revision;
    time += LIMITS.requestRetentionMs + 1; const result = store.compact();
    expect(result.revisions.s).toBe(before + 1); expect(store.session('s').projections).toEqual([]);
    store.close(); const next = reopen(owner, { now: () => time }); next.recover(); expect(next.session('s').revision).toBeGreaterThanOrEqual(before + 1);
  });
  it('persists explicit unsupported/abort/drain outcomes and expires only after the deadline', async () => {
    let time = now; const { store } = await open({ now: () => time });
    const pending = (id: string) => ({ id, scope: { kind: 'session', session: 's', root: 's' }, request: { kind: 'confirm', title: 'Confirm', message: '' }, state: 'waiting', createdAt: now, expiresAt: now + 100 });
    for (const reason of ['unsupported', 'abort', 'drain'] as const) {
      store.putInteraction(pending(reason)); expect(store.cancelInteraction(reason, reason).value).toMatchObject({ state: 'cancelled', result: { reason } });
      expect(() => store.cancelInteraction(reason, 'restart')).toThrow(/resolved/);
    }
    store.putInteraction(pending('expires')); expect(() => store.cancelInteraction('expires', 'timeout')).toThrow(/not expired/);
    time += 100; expect(store.cancelInteraction('expires', 'timeout').value).toMatchObject({ state: 'expired', result: { reason: 'timeout' } });
  });
  it('drops a row whose transcript was substituted by a symlink without quarantining the state', async () => {
    const { owner, store } = await open();
    const other = join(owner.target.agentDir, 'other.jsonl'); await writeFile(other, 'other');
    await symlink(other, join(owner.target.agentDir, 's.jsonl'));
    store.close(); const reopened = reopen(owner);
    expect(reopened.snapshot().sessions).toEqual([]);
    expect((await readdir(reopened.directory)).filter(name => name.startsWith('control-corrupt-'))).toEqual([]);
  });
});

describe.skipIf(!supported)('retained ambiguity', () => {
  it('does not age-evict winning answers or unresolved resource evidence', async () => {
    let time = now; const { owner, store } = await open({ now: () => time });
    store.putInteraction({ id: 'ask', scope: { kind: 'session', session: 's', root: 's' }, request: { kind: 'input', title: 'Continue?' }, deferrable: true, state: 'waiting', createdAt: now });
    const answer = { kind: 'input' as const, text: 'yes' };
    const id = requestId(); store.admit({ v: 1, id, op: 'interaction.answer', session: 's', params: { interactionId: 'ask', answer } }, 'winner');
    store.answerInteraction(id, answer, 'continue'); store.transitionContinuation('continue', 'dispatch_intent');
    store.putResource({ id: 'unresolved', session: 's', root: 's', kind: 'foreground', state: 'running', pid: 1234, startIdentity: 'unknown-outcome', updatedAt: now });
    store.close(); const reloaded = reopen(owner, { now: () => time }); reloaded.recover();
    time += 2 * LIMITS.requestRetentionMs; reloaded.compact();
    expect(reloaded.snapshot().requests).toEqual([]);
    expect(reloaded.snapshot().interactions[0]).toMatchObject({ state: 'answered', result: answer });
    expect(reloaded.snapshot().continuations[0]?.phase).toBe('indeterminate');
    expect(reloaded.snapshot().resources[0]?.id).toBe('unresolved');
  });
});

describe.skipIf(!supported)('reviewed persistence boundaries', () => {
  for (const deletion of ['directory', 'both-files'] as const) it(`rebuilds lost initialized state across owner reacquisition: ${deletion}`, async () => {
    const { owner, store, input } = await open(); const request = prompt();
    store.admit(request, 'owner'); store.markDispatched(request.id);
    store.finishRequest(request.id, { v: 1, re: request.id, outcome: 'accepted', result: { runId: 'done' } });
    store.updateSession('s', { policy: { effective: 'acp-strict', generation: 1 } });
    const revision = store.session('s').revision; expect(revision).toBeGreaterThan(1);
    store.close(); await owner.release();
    if (deletion === 'directory') await rm(store.directory, { recursive: true });
    else { await rm(join(store.directory, 'format.json')); await rm(join(store.directory, 'control.json')); }
    const nextOwner = await acquireDaemonOwnership(input); owners.push(nextOwner);
    const rebuilt = reopen(nextOwner);
    expect(rebuilt.snapshot().sessions).toEqual([]); expect(rebuilt.needsRecovery).toBe(false);
  });
  it('syncs new control directory entries in their parent and still creates genuinely new stores', async () => {
    const input = await target(); const owner = await acquireDaemonOwnership(input); owners.push(owner);
    const agent = fs.statSync(owner.target.agentDir); const directory = join(owner.target.agentDir, 'new', 'control');
    const syncs: string[] = []; const original = fs.fsyncSync;
    fs.fsyncSync = (fd: number) => {
      const stat = fs.fstatSync(fd);
      if (stat.dev === agent.dev && stat.ino === agent.ino) syncs.push(fs.existsSync(directory) ? 'parent-after-create' : 'initialization-parent');
      return original(fd);
    }; syncBuiltinESMExports();
    try { const store = new DaemonControlStore(owner, { directory }); stores.push(store); expect(store.needsRecovery).toBe(false); }
    finally { fs.fsyncSync = original; syncBuiltinESMExports(); }
    expect(syncs).toContain('initialization-parent'); expect(syncs).toContain('parent-after-create');
    const other = new DaemonControlStore(owner, { directory: join(owner.target.agentDir, 'other-control') }); stores.push(other);
    expect(other.snapshot().requests).toEqual([]);
  });
  it('persists a large valid terminal interaction', async () => {
    const { owner, store } = await open();
    const waiting = { id: 'large', scope: { kind: 'session', session: 's', root: 's' },
      request: { kind: 'form', form: { title: 'Large review', markdown: 'Q'.repeat(128000), fallback: 'Review all content',
        input: { defaults: { first: 'D'.repeat(22000), second: 'D'.repeat(22000) }, fields: [{ id: 'first', kind: 'string', label: 'First', required: true, maxLength: 32768 }, { id: 'second', kind: 'string', label: 'Second', required: true, maxLength: 32768 }] },
        actions: [{ id: 'submit', label: 'Submit', target: 'element', outcome: 'submit' }] } }, deferrable: true, state: 'waiting', createdAt: now };
    const answer = { kind: 'form' as const, actionId: 'submit', outcome: 'submit' as const, values: { first: 'A'.repeat(32000), second: 'A'.repeat(32000) } };
    store.putInteraction(waiting);
    const id = requestId(); store.admit({ v: 1, id, op: 'interaction.answer', session: 's', params: { interactionId: 'large', answer } }, 'winner');
    const result = store.answerInteraction(id, answer, 'continuation'); parseInteraction(result.value);
    expect(result.value.state).toBe('answered'); store.close();
    const reloaded = reopen(owner); reloaded.recover(); expect(reloaded.snapshot().interactions[0]?.state).toBe('answered');
  });
  it('retains rejected outcome diagnostics for retry lookup after reload', async () => {
    const { owner, store } = await open(); const request = prompt();
    store.admit(request, 'owner');
    const response = store.finishRequest(request.id, { v: 1, re: request.id, outcome: 'rejected', error: { code: 'busy', message: 'Session is busy.', retryable: true } }).value;
    expect(response).toMatchObject({ outcome: 'rejected', error: { code: 'busy', message: 'Session is busy.' } });
    store.close(); const reloaded = reopen(owner); reloaded.recover();
    expect(reloaded.admit(request, 'owner').value.response).toEqual(response);
  });
});

describe.skipIf(!supported)('fixed safety session transitions', () => {
  it('validates selectors and lifecycle preconditions without changing any record', async () => {
    const { store } = await open();
    const initial = store.snapshot();
    expect(() => store.transitionSessionForSafety('s', 'running' as never)).toThrow(/Unknown/);
    expect(() => store.transitionSessionForSafety('missing', 'closed')).toThrow(/not found/);
    expect(() => store.transitionSessionForSafety('s', 'cancelling')).toThrow(/existing active/);
    expect(store.snapshot()).toEqual(initial);
    for (const state of ['running', 'waiting', 'cancelling'] as const) {
      store.updateSession('s', { run: { state, id: 'current' } });
      const active = store.snapshot();
      expect(() => store.transitionSessionForSafety('s', 'closed')).toThrow(/Settle/);
      expect(() => store.transitionSessionForSafety('s', 'evicted')).toThrow(/Settle/);
      expect(store.snapshot()).toEqual(active);
    }
    store.updateSession('s', { run: { state: 'running' } });
    expect(() => store.transitionSessionForSafety('s', 'cancelling')).toThrow(/existing active/);
    store.updateSession('s', { run: { state: 'interrupted', id: 'current' } });
    expect(() => store.transitionSessionForSafety('s', 'cancelling')).toThrow(/existing active/);
    store.transitionSessionForSafety('s', 'closed');
    expect(() => store.transitionSessionForSafety('s', 'cancelling')).toThrow(/existing active/);
    expect(store.updateSession('s', { state: 'open' }).value.state).toBe('open');
  });

  it('preserves full records and makes repeated transitions revision-idempotent', async () => {
    const { store, owner } = await open();
    const request = prompt(); store.admit(request, 'owner'); store.markDispatched(request.id);
    store.project('s', [{ type: 'status', id: 'keep', text: 'unchanged' }]);
    store.putResource({ id: 'detached', session: 's', root: 's', kind: 'detached', state: 'running', reference: join(owner.target.agentDir, 'job.json'), startIdentity: 'birth', updatedAt: now });
    store.updateSession('s', { run: { state: 'running', id: 'current', origin: { kind: 'headless', attachment: 'original' } }, policy: { effective: 'acp-strict', generation: 1 }, title: 'keep title', branch: 'keep branch', model: { provider: 'offline', id: 'test' }, thinking: 'off' });
    for (const transition of ['cancelling', 'idle', 'closed', 'evicted'] as const) {
      const before = store.snapshot(); const old = store.session('s'); const commit = store.transitionSessionForSafety('s', transition);
      const changed = transition !== 'evicted';
      const expected = { ...old, ...(transition === 'closed' ? { state: 'closed', residency: 'evicted' } : {}),
        run: { ...old.run, state: transition === 'cancelling' ? 'cancelling' : transition === 'evicted' ? old.run.state : 'idle' },
        revision: old.revision + (changed ? 1 : 0), updatedAt: now };
      expect(commit.value).toEqual(expected);
      expect(store.snapshot()).toEqual({ ...before, sessions: [expected] });
      const repeated = store.transitionSessionForSafety('s', transition);
      expect(repeated.revisions).toEqual({}); expect(repeated.value).toEqual(commit.value);
    }
  });

  it('requires recovery and current ownership even for an idempotent transition', async () => {
    const { owner, store } = await open(); store.transitionSessionForSafety('s', 'evicted'); store.close();
    const next = reopen(owner);
    expect(() => next.transitionSessionForSafety('s', 'evicted')).toThrow(/Recover/);
    next.recover(); expect(next.transitionSessionForSafety('s', 'evicted').revisions).toEqual({});
    await owner.release(); expect(() => next.transitionSessionForSafety('s', 'evicted')).toThrow();
  });

  for (const boundary of ['before_write', 'after_write', 'after_file_sync', 'before_rename', 'after_rename', 'after_directory_sync'] as PersistenceBoundary[]) {
    it(`does not return a safety commit after a fault at ${boundary}`, async () => {
      let fail = false;
      const { owner, store } = await open({ fault: at => { if (fail && at === boundary) throw new Error('injected safety write failure'); } });
      store.updateSession('s', { run: { state: 'running', id: 'original' } });
      const request = prompt(); store.admit(request, 'owner'); store.markDispatched(request.id);
      fail = true;
      expect(() => store.transitionSessionForSafety('s', 'cancelling')).toThrow(/commit failed/);
      expect(() => store.transitionSessionForSafety('s', 'idle')).toThrow(/fenced/);
      store.close(); const next = reopen(owner);
      expect(next.session('s').run.state).toBe(['after_rename', 'after_directory_sync'].includes(boundary) ? 'cancelling' : 'running');
      next.recover(); expect(next.session('s').run).toMatchObject({ state: 'interrupted', id: 'original' });
      expect(next.snapshot().requests[0]?.response?.outcome).toBe('indeterminate');
    });
  }
});

describe.skipIf(!supported)('control file recovery', () => {
  const corrupt = async (directory: string) => (await readdir(directory)).filter(name => name.startsWith('control-corrupt-'));

  it('starts empty without quarantine when the control file is missing', async () => {
    const { owner, store } = await open(); const directory = store.directory; store.close();
    await unlink(join(directory, 'control.json'));
    expect(reopen(owner).snapshot().sessions).toEqual([]);
    expect(await corrupt(directory)).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)('fails retryably without quarantine when the control file cannot be read', async () => {
    const { owner, store } = await open(); const directory = store.directory; const path = join(directory, 'control.json'); store.close();
    const before = await readFile(path, 'utf8'); await chmod(path, 0o000);
    try { expect(() => reopen(owner)).toThrow(expect.objectContaining({ code: 'storage_failure', message: expect.stringContaining('EACCES') })); }
    finally { await chmod(path, 0o600); }
    expect(await readFile(path, 'utf8')).toBe(before);
    expect(await corrupt(directory)).toEqual([]);
  });

  it('keeps a row whose session directory is outside the current roots and owns that directory again', async () => {
    const { owner, store, input } = await open(); const directory = store.directory; const path = join(directory, 'control.json'); store.close();
    const custom = join(await realpath(input.directory), 'custom-sessions'); await mkdir(custom);
    const piPath = join(custom, 's.jsonl');
    const envelope = JSON.parse(await readFile(path, 'utf8')) as { data: { sessions: { piPath: string }[] }; digest: string };
    envelope.data.sessions[0]!.piPath = piPath;
    envelope.digest = createHash('sha256').update(JSON.stringify(envelope.data)).digest('hex');
    await writeFile(path, JSON.stringify(envelope), { mode: 0o600 });
    expect(() => owner.assertOwnsPath(piPath)).toThrow(/outside/);
    const reopened = reopen(owner);
    expect(reopened.snapshot().sessions.map(session => session.piPath)).toEqual([piPath]);
    await reopened.ownPersistedRoots();
    expect(owner.assertOwnsPath(piPath)).toBe(piPath);
    expect(reopened.snapshot().sessions.map(session => session.piPath)).toEqual([piPath]);
    expect(await corrupt(directory)).toEqual([]);
  });
});
