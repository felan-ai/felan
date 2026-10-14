import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIMITS, type ClientEnvelope, type Response } from '@felan-ai/session-protocol';
import { OrderedAdmission, SAFETY_BYTES, diagnosticMessage, type AdmittedCommand } from '../src/daemon/admission.js';
import { ControlStoreError } from '../src/daemon/control-state.js';
import { DaemonControlStore, type ControlStoreOptions } from '../src/daemon/control-store.js';
import type { DaemonOwnership } from '../src/daemon/ownership.js';

const now = 1_800_000_000_000;
const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(now); });
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function requestId(timestamp = now): string {
  const hex = timestamp.toString(16).padStart(12, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8)}-7${randomUUID().slice(1, 4)}-8${randomUUID().slice(1, 4)}-${randomUUID().slice(-12)}`;
}
function prompt(text = 'offline', session = 's', id = requestId()): ClientEnvelope {
  return { v: 1, id, op: 'prompt', session, params: { text } };
}
function accepted(id: string): Response { return { v: 1, re: id, outcome: 'accepted', result: { runId: 'run' } }; }
function empty(id: string): Response { return { v: 1, re: id, outcome: 'accepted', result: {} }; }
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function fixture(options: ControlStoreOptions = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'a7-')));
  const stores: DaemonControlStore[] = [];
  let lost = false;
  const assertCurrent = () => { if (lost) throw new ControlStoreError('ownership_lost', 'Synthetic ownership loss'); };
  // Persistence is real; account-wide kernel ownership is deliberately not acquired by unit fixtures.
  const owner = {
    target: { agentDir: directory, rootSet: [directory], uid: process.getuid!(), namespaceId: randomUUID() },
    assertCurrent,
    assertOwnsPath(input: string) {
      assertCurrent(); const path = resolve(input); const child = relative(directory, path);
      if (child === '..' || child.startsWith('../') || isAbsolute(child)) throw new Error('Path outside private fixture');
      return path;
    },
    async ownRoot(input: string) { owner.assertOwnsPath(input); },
    watchPath() { return () => {}; },
  } as unknown as DaemonOwnership;
  const open = () => { const store = new DaemonControlStore(owner, { now: () => now, ...options }); stores.push(store); return store; };
  cleanups.push(async () => { for (const store of stores) store.close(); await rm(directory, { recursive: true, force: true }); });
  const store = open();
  for (const id of ['s', 'other']) store.createSession({ id, root: id, cwd: directory, piPath: join(directory, `${id}.jsonl`),
    state: 'open', residency: 'warm', run: { state: 'idle' }, policy: { effective: 'host-default', generation: 0 }, title: '' });
  return { store, open, lose: () => { lost = true; }, disk: () => JSON.parse(readFileSync(join(store.directory, 'control.json'), 'utf8')).data };
}

describe('ordered durable admission', () => {
  it('commits intent, dispatch and sanitized outcome in order before returning', async () => {
    const f = await fixture(); const admission = new OrderedAdmission(f.store); const request = prompt();
    const order: string[] = [];
    const response = await admission.submit(request, 'local-owner', command => {
      order.push(f.disk().requests[0].phase);
      return command.dispatch(() => {
        order.push(f.disk().requests[0].phase);
        return { response: { ...accepted(request.id), ignored: 'not published' } };
      });
    });
    expect(order).toEqual(['intent', 'dispatch_intent']);
    expect(response).toEqual(accepted(request.id));
    expect(f.disk().requests[0]).toMatchObject({ phase: 'terminal', response });
    expect(JSON.stringify(f.disk())).not.toContain('offline');
  });

  it('joins identical live retries, strips unknown fields and retains the result across controllers', async () => {
    const f = await fixture(); const admission = new OrderedAdmission(f.store); const request = prompt();
    const outcome = deferred<Response>(); const started = deferred<void>();
    const handler = vi.fn((command: AdmittedCommand) => command.dispatch(() => { started.resolve(); return { response: outcome.promise }; }));
    const first = admission.submit(request, 'local-owner', handler);
    const second = admission.submit({ ...request, id: request.id.toUpperCase(), principal: 'forged', params: { text: 'offline', ignored: 'extra' } }, 'local-owner', handler);
    await started.promise; expect(handler).toHaveBeenCalledOnce();
    outcome.resolve(accepted(request.id));
    expect(await second).toEqual(await first);
    const repeated = vi.fn();
    expect(await new OrderedAdmission(f.store).submit(request, 'local-owner', repeated)).toEqual(accepted(request.id));
    expect(repeated).not.toHaveBeenCalled();
  });

  it('rejects changed payload, principal, operation and session for a live request ID', async () => {
    const f = await fixture(); const admission = new OrderedAdmission(f.store); const request = prompt();
    const outcome = deferred<Response>(); const started = deferred<void>();
    const first = admission.submit(request, 'owner', command => command.dispatch(() => { started.resolve(); return { response: outcome.promise }; }));
    await started.promise;
    const handler = vi.fn();
    for (const [value, principal] of [
      [prompt('changed', 's', request.id), 'owner'], [request, 'another-owner'],
      [{ v: 1, id: request.id, op: 'cancel', session: 's', params: {} }, 'owner'],
      [prompt('offline', 'other', request.id), 'owner'],
    ] as const) await expect(admission.submit(value, principal, handler)).rejects.toMatchObject({ code: 'request_conflict' });
    expect(handler).not.toHaveBeenCalled();
    outcome.resolve(accepted(request.id)); await first;
  });

  it('bounds live duplicate waiters and gives each caller its own committed response', async () => {
    const f = await fixture(); const admission = new OrderedAdmission(f.store, { maxPending: 2 });
    const request = prompt(); const outcome = deferred<Response>(); const handler = vi.fn();
    const first = admission.submit(request, 'owner', command => command.dispatch(() => ({ response: outcome.promise })));
    const duplicates = [admission.submit(request, 'owner', handler), admission.submit(request, 'owner', handler)];
    await expect(admission.submit(request, 'owner', handler)).rejects.toMatchObject({ code: 'request_capacity' });
    outcome.resolve(accepted(request.id));
    const responses = await Promise.all([first, ...duplicates]);
    responses[0]!.re = 'changed';
    expect(responses[1]).toEqual(accepted(request.id)); expect(responses[2]).toEqual(accepted(request.id));
    expect(await admission.submit(request, 'owner', handler)).toEqual(accepted(request.id));
    expect(handler).not.toHaveBeenCalled();
  });

  it('serializes preparation but releases the lane before a dispatched turn completes', async () => {
    const f = await fixture(); const admission = new OrderedAdmission(f.store);
    const gate = deferred<void>(); const entered = deferred<void>(); const outcome = deferred<Response>();
    const request = prompt('long'); const order: string[] = [];
    const first = admission.submit(request, 'owner', async command => {
      order.push('prepare-first'); entered.resolve(); await gate.promise;
      return command.dispatch(() => { order.push('dispatch-first'); return { response: outcome.promise }; });
    });
    const secondRequest = prompt('next');
    const second = admission.submit(secondRequest, 'owner', command => command.dispatch(() => {
      order.push('dispatch-second'); return { response: accepted(secondRequest.id) };
    }));
    await entered.promise; expect(order).toEqual(['prepare-first']);
    gate.resolve(); expect(await second).toEqual(accepted(secondRequest.id));
    expect(order).toEqual(['prepare-first', 'dispatch-first', 'dispatch-second']);
    expect(f.store.snapshot().requests.find(row => row.id === request.id)?.phase).toBe('dispatch_intent');
    outcome.resolve(accepted(request.id)); await first;
  });

  it('allows another session and host lane to proceed during session preparation', async () => {
    const f = await fixture(); const admission = new OrderedAdmission(f.store); const gate = deferred<void>();
    const request = prompt();
    const first = admission.submit(request, 'owner', async command => { await gate.promise; return command.dispatch(() => ({ response: accepted(request.id) })); });
    const other = prompt('other', 'other');
    expect(await admission.submit(other, 'owner', command => command.dispatch(() => ({ response: accepted(other.id) })))).toEqual(accepted(other.id));
    const host: ClientEnvelope = { v: 1, id: requestId(), op: 'sessions.create', params: { cwd: '/fixture', source: 'tui' } };
    expect(await admission.submit(host, 'owner', command => command.dispatch(() => ({ response: { v: 1, re: host.id, outcome: 'accepted', result: { sessionId: 'created' } } })))).toMatchObject({ outcome: 'accepted' });
    gate.resolve(); await first;
  });

  it('does not double-mark a registry-managed dispatch', async () => {
    const f = await fixture(); const admission = new OrderedAdmission(f.store); const request = prompt();
    const mark = vi.spyOn(f.store, 'markDispatched');
    expect(await admission.submit(request, 'owner', command => {
      command.assertDispatch();
      f.store.markDispatched(request.id);
      return { response: accepted(request.id) };
    })).toEqual(accepted(request.id));
    expect(mark).toHaveBeenCalledExactlyOnceWith(request.id);
  });

  it('rejects a second dispatch and revokes a leaked dispatch permit', async () => {
    const f = await fixture(); const admission = new OrderedAdmission(f.store); const request = prompt(); const effect = vi.fn();
    expect(await admission.submit(request, 'owner', command => {
      command.dispatch(effect); command.dispatch(effect); return { response: accepted(request.id) };
    })).toMatchObject({ outcome: 'indeterminate' });
    expect(effect).toHaveBeenCalledOnce();
    let leaked!: AdmittedCommand;
    const next = prompt();
    expect(await admission.submit(next, 'owner', command => { leaked = command; return { response: accepted(next.id) }; }))
      .toMatchObject({ outcome: 'rejected', error: { code: 'invalid_request' } });
    expect(() => leaked.dispatch(effect)).toThrow('before admission completes');
    expect(effect).toHaveBeenCalledOnce();
  });

  it('explicitly rejects an unwired broker without marking dispatch or resolving an interaction', async () => {
    const f = await fixture(); const admission = new OrderedAdmission(f.store); const id = requestId();
    const response = await admission.submit({ v: 1, id, op: 'interaction.answer', session: 's',
      params: { interactionId: 'missing', answer: { cancelled: true, reason: 'user' } } }, 'owner');
    expect(response).toMatchObject({ outcome: 'rejected', error: { code: 'unavailable' } });
    expect(f.store.snapshot().requests[0]).toMatchObject({ phase: 'terminal', response });
    expect(f.store.snapshot().interactions).toEqual([]);
    expect(f.store.session('s').revision).toBe(1);
  });

  it('reports undispatched failure messages and hides ambiguous effect diagnostics', async () => {
    const f = await fixture(); const admission = new OrderedAdmission(f.store);
    const before = await admission.submit(prompt(), 'owner', () => { throw new ControlStoreError('request_conflict', 'Readable\nfailure'); });
    expect(before).toMatchObject({ outcome: 'rejected', error: { code: 'request_conflict', message: 'Readable failure', retryable: false } });
    const request = prompt();
    const after = await admission.submit(request, 'owner', command => command.dispatch(() => { throw new Error('sensitive diagnostic'); }));
    expect(after).toMatchObject({ outcome: 'indeterminate', error: { code: 'indeterminate', retryable: false } });
    expect(JSON.stringify([after, f.disk()])).not.toContain('sensitive diagnostic');
  });

  it('records a failed asynchronous outcome without blocking subsequent admission', async () => {
    const f = await fixture(); const admission = new OrderedAdmission(f.store); const outcome = deferred<Response>();
    const request = prompt();
    const first = admission.submit(request, 'owner', command => command.dispatch(() => ({ response: outcome.promise })));
    expect(await admission.submit(prompt('next'), 'owner')).toMatchObject({ outcome: 'rejected', error: { code: 'unavailable' } });
    outcome.reject(new Error('private asynchronous error'));
    expect(await first).toMatchObject({ outcome: 'indeterminate', error: { code: 'indeterminate' } });
    expect(JSON.stringify(f.disk())).not.toContain('private asynchronous error');
    expect(await admission.submit(request, 'owner', vi.fn())).toMatchObject({ outcome: 'indeterminate' });
  });

  it('rejects invalid correlated results rather than recording a false success', async () => {
    const f = await fixture(); const admission = new OrderedAdmission(f.store);
    for (const invalid of [empty('wrong'), accepted('wrong'), { v: 1, re: 'wrong', outcome: 'accepted', result: { state: 'ready' } }]) {
      const request = prompt();
      expect(await admission.submit(request, 'owner', command => command.dispatch(() => ({ response: invalid as Response }))))
        .toMatchObject({ re: request.id, outcome: 'indeterminate' });
    }
    const request = prompt();
    expect(await admission.submit(request, 'owner', command => command.dispatch(() => ({ response: empty(request.id) }))))
      .toMatchObject({ re: request.id, outcome: 'indeterminate' });
  });

  it('never dispatches retained intent or dispatch ambiguity without an active local handler', async () => {
    const f = await fixture(); const admission = new OrderedAdmission(f.store); const handler = vi.fn();
    for (const dispatched of [false, true]) {
      const request = prompt(); f.store.admit(request, 'owner'); if (dispatched) f.store.markDispatched(request.id);
      const response = await admission.submit(request, 'owner', handler);
      expect(response).toMatchObject({ outcome: dispatched ? 'indeterminate' : 'rejected' });
      expect(await admission.submit(request, 'owner', handler)).toEqual(response);
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns recovered outcomes without replaying effects', async () => {
    const f = await fixture(); const requests = [prompt('intent'), prompt('dispatch'), prompt('complete')];
    for (const request of requests) f.store.admit(request, 'owner');
    f.store.markDispatched(requests[1]!.id); f.store.markDispatched(requests[2]!.id);
    f.store.finishRequest(requests[2]!.id, accepted(requests[2]!.id)); f.store.close();
    const store = f.open(); store.recover(); const admission = new OrderedAdmission(store); const handler = vi.fn();
    const results = await Promise.all(requests.map(request => admission.submit(request, 'owner', handler)));
    expect(results.map(response => response.outcome)).toEqual(['rejected', 'indeterminate', 'accepted']);
    expect(handler).not.toHaveBeenCalled();
  });

  it('bounds pending requests while allowing duplicates and reserved cancellation capacity', async () => {
    const f = await fixture(); const admission = new OrderedAdmission(f.store, { maxPending: 3 });
    const requests = [prompt('first'), prompt('second')]; const outcomes = requests.map(() => deferred<Response>());
    const runs = requests.map((request, index) => admission.submit(request, 'owner', command => command.dispatch(() => ({ response: outcomes[index]!.promise }))));
    await expect(admission.submit(prompt('overflow'), 'owner')).rejects.toMatchObject({ code: 'request_capacity' });
    const duplicate = admission.submit(requests[0], 'owner', vi.fn());
    const cancel: ClientEnvelope = { v: 1, id: requestId(), op: 'cancel', session: 's', params: {} };
    expect(await admission.submit(cancel, 'owner', command => command.dispatch(() => ({ response: empty(cancel.id) })))).toEqual(empty(cancel.id));
    outcomes.forEach((outcome, index) => outcome.resolve(accepted(requests[index]!.id)));
    await Promise.all([...runs, duplicate]);
    expect(f.store.snapshot().requests).toHaveLength(3);
  });

  it('bounds pending encoded bytes and frees capacity after completion', async () => {
    const f = await fixture(); const admission = new OrderedAdmission(f.store, { maxBytes: SAFETY_BYTES + 512 });
    const request = prompt('x'.repeat(200)); const outcome = deferred<Response>();
    const run = admission.submit(request, 'owner', command => command.dispatch(() => ({ response: outcome.promise })));
    await expect(admission.submit(prompt('x'.repeat(200)), 'owner')).rejects.toMatchObject({ code: 'request_capacity' });
    await expect(admission.submit(request, 'owner')).rejects.toMatchObject({ code: 'request_capacity' });
    const cancel: ClientEnvelope = { v: 1, id: requestId(), op: 'cancel', session: 's', params: {} };
    expect(await admission.submit(cancel, 'owner')).toMatchObject({ outcome: 'rejected', error: { code: 'unavailable' } });
    outcome.resolve(accepted(request.id)); await run;
    expect(await admission.submit(prompt('x'.repeat(200)), 'owner')).toMatchObject({ outcome: 'rejected' });
  });

  it('validates requests, principals and limits without admitting invalid data', async () => {
    const f = await fixture(); const admission = new OrderedAdmission(f.store); const handler = vi.fn();
    for (const request of [{ v: 1, id: 'read', op: 'host.status', params: {} }, { ...prompt(), op: 'unknown' }]) {
      await expect(admission.submit(request, 'owner', handler)).rejects.toMatchObject({ code: 'invalid_request' });
    }
    await expect(admission.submit(prompt(), '', handler)).rejects.toMatchObject({ code: 'invalid_request' });
    expect(f.store.snapshot().requests).toEqual([]); expect(handler).not.toHaveBeenCalled();
    for (const options of [{ maxPending: 1 }, { maxPending: 65 }, { maxPending: 2.5 }, { maxBytes: SAFETY_BYTES }, { maxBytes: LIMITS.unsentBytes + 1 }]) {
      expect(() => new OrderedAdmission(f.store, options)).toThrow('safety capacity');
    }
  });

  it('uses the normalized request captured before the caller mutates its object', async () => {
    const f = await fixture(); const admission = new OrderedAdmission(f.store); const request = prompt('original');
    const run = admission.submit(request, 'owner', command => command.dispatch(() => {
      expect(command.request).toMatchObject({ params: { text: 'original' } }); return { response: accepted(request.id) };
    }));
    if (request.op === 'prompt') request.params.text = 'mutated';
    expect(await run).toMatchObject({ outcome: 'accepted' });
    expect(await admission.submit(prompt('original', 's', request.id), 'owner')).toMatchObject({ outcome: 'accepted' });
  });

  for (const boundary of ['before_rename', 'after_rename'] as const) {
    it(`does not publish or dispatch after admission persistence fails ${boundary}`, async () => {
      let fail = false; const f = await fixture({ fault: at => { if (fail && at === boundary) throw new Error('synthetic disk failure'); } });
      const request = prompt(); const handler = vi.fn(); fail = true;
      await expect(new OrderedAdmission(f.store).submit(request, 'owner', handler)).rejects.toMatchObject({ code: 'storage_failure' });
      expect(handler).not.toHaveBeenCalled(); f.store.close(); fail = false;
      const store = f.open(); store.recover();
      if (boundary === 'after_rename') expect(await new OrderedAdmission(store).submit(request, 'owner', handler)).toMatchObject({ outcome: 'rejected' });
      expect(handler).not.toHaveBeenCalled();
    });

    it(`does not invoke an effect after dispatch persistence fails ${boundary}`, async () => {
      let fail = false; const f = await fixture({ fault: at => { if (fail && at === boundary) throw new Error('synthetic disk failure'); } });
      const request = prompt(); const effect = vi.fn();
      await expect(new OrderedAdmission(f.store).submit(request, 'owner', command => {
        fail = true; return command.dispatch(() => { effect(); return { response: accepted(request.id) }; });
      })).rejects.toMatchObject({ code: 'storage_failure' });
      expect(effect).not.toHaveBeenCalled(); f.store.close(); fail = false;
      const store = f.open(); store.recover();
      expect(await new OrderedAdmission(store).submit(request, 'owner', vi.fn())).toMatchObject({ outcome: boundary === 'after_rename' ? 'indeterminate' : 'rejected' });
    });

    it(`does not publish success or repeat an effect after outcome persistence fails ${boundary}`, async () => {
      let fail = false; const f = await fixture({ fault: at => { if (fail && at === boundary) throw new Error('synthetic disk failure'); } });
      const request = prompt(); const effect = vi.fn();
      await expect(new OrderedAdmission(f.store).submit(request, 'owner', command => command.dispatch(() => {
        effect(); fail = true; return { response: accepted(request.id) };
      }))).rejects.toMatchObject({ code: 'storage_failure' });
      f.store.close(); fail = false; const store = f.open(); store.recover();
      const replay = vi.fn();
      expect(await new OrderedAdmission(store).submit(request, 'owner', replay)).toMatchObject({ outcome: boundary === 'after_rename' ? 'accepted' : 'indeterminate' });
      expect(effect).toHaveBeenCalledOnce(); expect(replay).not.toHaveBeenCalled();
    });
  }

  it('rechecks ownership after asynchronous preparation and before dispatch', async () => {
    const f = await fixture(); const admission = new OrderedAdmission(f.store); const gate = deferred<void>(); const entered = deferred<void>(); const effect = vi.fn();
    const run = admission.submit(prompt(), 'owner', async command => {
      entered.resolve(); await gate.promise; return command.dispatch(() => { effect(); return { response: accepted(command.request.id) }; });
    });
    await entered.promise; f.lose(); gate.resolve();
    await expect(run).rejects.toMatchObject({ code: 'ownership_lost' }); expect(effect).not.toHaveBeenCalled();
  });
});

describe('adoption and deletion admission boundaries', () => {

  it('atomically clears projections on deletion, keeps the tombstone for retries and prunes it with request history', async () => {
    let clock = now; const f = await fixture({ now: () => clock });
    f.store.project('s', [{ type: 'status', id: 'history', text: 'retained audit' }]);
    const revision = f.store.session('s').revision;
    const request: ClientEnvelope = { v: 1, id: requestId(), op: 'session.delete', session: 's', params: {} };
    f.store.admit(request, 'owner');
    const commit = f.store.markSessionDeleted(request.id);
    expect(commit.value).toMatchObject({ deletedAt: now, state: 'closed', residency: 'evicted', revision: revision + 1 });
    expect(commit.revisions).toEqual({ s: revision + 1 });
    expect(commit.value.projections).toEqual([]);
    expect(f.disk().requests.find((row: { id: string }) => row.id === request.id)).toMatchObject({ phase: 'dispatch_intent' });
    expect(f.disk().sessions.find((row: { id: string }) => row.id === 's')).toMatchObject({ deletedAt: now });
    f.store.finishRequest(request.id, empty(request.id));
    expect(() => f.store.updateSession('s', { state: 'open' })).toThrowError(/deleted/);
    expect(() => f.store.transitionSessionForSafety('s', 'idle')).toThrowError(/deleted/);
    expect(() => f.store.project('s', [])).toThrowError(/deleted/);
    f.store.close(); const reopened = f.open(); reopened.recover();
    expect(reopened.session('s').deletedAt).toBe(now);
    clock += LIMITS.requestRetentionMs + 1; reopened.compact();
    expect(reopened.snapshot().requests.some(row => row.id === request.id)).toBe(false);
    expect(reopened.snapshot().sessions.some(row => row.id === 's')).toBe(false);
    const fresh = prompt('capacity remains usable', 'other', requestId(clock));
    expect(reopened.admit(fresh, 'owner').value.phase).toBe('intent');
  });
});

describe('diagnostic messages', () => {
  it('passes real failure text through while masking credentials and quoted JSON content', () => {
    expect(diagnosticMessage(new Error('Session file not found: /tmp/a.jsonl'))).toBe('Session file not found: /tmp/a.jsonl');
    const leaked = diagnosticMessage(new Error('401 from provider: Authorization: Bearer abc.def apiKey="sk-live-1234567890abcdef" {"refresh_token": "r-secret-value"} ghp_abcdefghijklmnop'));
    for (const secret of ['abc.def', 'sk-live-1234567890abcdef', 'r-secret-value', 'ghp_abcdefghijklmnop']) expect(leaked).not.toContain(secret);
    expect(leaked).toContain('401 from provider');
    let parseError: unknown; try { JSON.parse('{"openai": {"key": "sk-quoted-secret-value"'); } catch (error) { parseError = error; }
    expect(diagnosticMessage(parseError)).toBe('A file or response contains invalid JSON.');
  });
});
