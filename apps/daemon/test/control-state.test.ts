import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { requestRetainUntil } from '@felan-ai/session-protocol';
import { ControlStateValidationError, parseControlState, type ControlState } from '../src/daemon/control-state.js';

import { DaemonControlStore } from '../src/daemon/control-store.js';
import { fixture as storeFixture, fixtures } from './fixtures/registry.js';
import { readControlDatabase, writeControlDatabase, type PersistedControlState } from './fixtures/control-database.js';

afterEach(async () => { for (const dispose of fixtures.splice(0)) await dispose(); });

const NOW = 1_800_000_000_000;
const DIGEST = 'a'.repeat(64);

function requestId(index: number): string {
  const timestamp = NOW.toString(16).padStart(12, '0');
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7000-8000-${index.toString(16).padStart(12, '0')}`;
}

function fixture(): ControlState {
  const root: ControlState['sessions'][number] = {
    id: 'root', root: 'root', cwd: '/workspace/original', piPath: '/agent/sessions/root.jsonl',
    revision: 42, updatedAt: NOW + 91, state: 'open', residency: 'warm', title: 'Original title 界',
    run: { state: 'waiting', id: 'run', turnId: 'turn' },
    policy: { effective: 'host-default', generation: 7 },
    branch: 'selected-leaf', observedTip: 'newer-tip', model: { provider: 'provider', id: 'model' }, thinking: 'high',
    profile: { extensionPaths: ['/installed/extension.mjs'],
      extensionConfigOverrides: [{ extensionId: 'feature', source: 'original profile', values: { enabled: true, unknownOptions: { retain: [null, 'original'] } } }] },
    projections: [{ key: 'message:user', updatedAt: NOW + 17, value: { type: 'message', id: 'user', entryId: 'entry', state: 'observed' } },
      { key: 'queue', updatedAt: NOW + 18, value: { type: 'queue', ids: ['queued-turn'], identity: { sha256: DIGEST, bytes: 123 } } }],
  };
  const state: ControlState = {
    version: 1, namespace: 'original-namespace', agentDir: '/agent', clock: NOW + 99,
    sessions: [root, { ...root, id: 'child', parent: 'root', cwd: '/workspace/child', piPath: '/agent/sessions/child.jsonl',
      revision: 4, run: { state: 'running', id: 'child-run' }, profile: {}, projections: [] }],
    requests: [0, 1, 2, 3, 4].map((index): ControlState['requests'][number] => {
      const id = requestId(index);
      return { id, principal: 'local-owner', session: 'root', op: 'prompt', admittedAt: NOW,
        retainUntil: requestRetainUntil(id, NOW), identity: { sha256: DIGEST, bytes: 987 },
        phase: index === 0 ? 'intent' : index === 1 ? 'dispatch_intent' : 'terminal',
        ...(index < 2 ? {} : { response: index === 2
          ? { v: 1 as const, re: id, outcome: 'accepted' as const, result: { runId: 'accepted-run' } }
          : { v: 1 as const, re: id, outcome: index === 3 ? 'rejected' as const : 'indeterminate' as const,
            error: { code: index === 3 ? 'unavailable' as const : 'indeterminate' as const, retryable: false, message: 'Original outcome diagnostic.' } } }),
      };
    }),
    interactions: [
      { id: 'waiting', scope: { kind: 'session', session: 'root', root: 'root' }, request: { kind: 'confirm', title: 'Original prompt', message: 'Pending approval' },
        createdAt: NOW - 1000, expiresAt: NOW - 1, state: 'waiting' },
      { id: 'deferred', scope: { kind: 'session', session: 'root', root: 'root' }, request: { kind: 'input', title: 'Pending question?' },
        deferrable: true, createdAt: NOW + 1, expiresAt: NOW + 5001, state: 'deferred' },
      { id: 'answered', scope: { kind: 'session', session: 'root', root: 'root' }, request: { kind: 'input', title: 'Continue?' },
        deferrable: true, createdAt: NOW + 2, state: 'answered', responder: 'original-attachment', resolvedAt: NOW + 3,
        result: { kind: 'input', text: 'Original winning answer.' } },
    ],
    continuations: (['ready', 'dispatch_intent', 'indeterminate', 'completed', 'cancelled'] as const).map((phase, index) => ({
      id: `continuation-${index}`, interaction: 'answered', session: 'root', phase, createdAt: NOW + 4, updatedAt: NOW + 5 + index,
    })),
    resources: [
      { id: 'process', session: 'root', root: 'root', kind: 'detached', state: 'reconciling', reference: '/agent/processes/original', pid: 123, startIdentity: 'original-process-start', updatedAt: NOW + 6 },
      { id: 'child-resource', session: 'child', root: 'root', kind: 'foreground', state: 'running', updatedAt: NOW + 7 },
    ],

  };
  return state;
}

async function reopenStore(input: ControlState): Promise<{ store: DaemonControlStore; original: PersistedControlState; directory: string }> {
  const f = await storeFixture();
  await f.registry.shutdown();
  const directory = f.store.directory;
  f.store.close();
  const state = structuredClone(input);
  state.namespace = f.owner.target.namespaceId;
  state.agentDir = f.owner.target.agentDir;
  for (const session of state.sessions) session.piPath = join(state.agentDir, `${session.id}.jsonl`);
  for (const resource of state.resources) if (resource.reference) resource.reference = join(state.agentDir, resource.id);
  writeControlDatabase(directory, state as unknown as PersistedControlState);
  const original = readControlDatabase(directory);
  return { store: new DaemonControlStore(f.owner), original, directory };
}

async function expectQuarantinedStore(input: ControlState): Promise<void> {
  const { store, original, directory } = await reopenStore(input);
  expect(store.snapshot().sessions).toEqual([]);
  expect(store.needsRecovery).toBe(false);
  store.close();
  const quarantined = (await readdir(directory)).filter(name => name.startsWith('control-corrupt-'));
  expect(quarantined).toHaveLength(1);
  expect(readControlDatabase(directory, join(directory, quarantined[0]!))).toEqual(original);
}

async function expectRepairedStore(input: ControlState): Promise<ControlState> {
  const { store, directory } = await reopenStore(input);
  const snapshot = store.snapshot();
  expect(store.needsRecovery).toBe(true);
  store.close();
  expect((await readdir(directory)).filter(name => name.startsWith('control-corrupt-'))).toEqual([]);
  return snapshot;
}

describe('control-state validation', () => {
  it('retains every control value without performing recovery', () => {
    const input = fixture();
    const before = structuredClone(input);
    const result = parseControlState(input);
    expect(result.version).toBe(1);
    expect(result).toEqual(before);
    expect(result).not.toBe(input);
    expect(input).toEqual(before);
    expect(result.sessions[0]!.profile).toEqual(before.sessions[0]!.profile);
    expect(result.requests.map(row => row.phase)).toEqual(['intent', 'dispatch_intent', 'terminal', 'terminal', 'terminal']);
    expect(result.requests[4]!.response?.outcome).toBe('indeterminate');
    expect(result.interactions.map(row => row.state)).toEqual(['waiting', 'deferred', 'answered']);
    expect(result.continuations.map(row => row.phase)).toEqual(['ready', 'dispatch_intent', 'indeterminate', 'completed', 'cancelled']);
  });

  it('parses a detached state idempotently', () => {
    const input = fixture();
    const result = parseControlState(input);
    input.sessions[0]!.title = 'changed externally';
    expect(result.sessions[0]!.title).toBe('Original title 界');
    expect(parseControlState(result)).toEqual(result);
    expect(parseControlState(result)).not.toBe(result);
  });

  it.each([undefined, null, {}, { version: 0 }, { version: 3 }, { version: '1' }, { version: 2, legacy: {} }, { version: 1 }])('rejects absent, unsupported or malformed input without creating an empty state', input => {
    expect(() => parseControlState(input)).toThrow(ControlStateValidationError);
  });

  it.each([
    (state: ControlState) => { state.sessions.push(structuredClone(state.sessions[0]!)); },
    (state: ControlState) => { state.sessions[1]!.parent = 'missing'; },
    (state: ControlState) => { state.sessions[1]!.parent = 'child'; },
    (state: ControlState) => { state.sessions[1]!.root = 'child'; },
    (state: ControlState) => { delete state.requests[2]!.response; },
    (state: ControlState) => { state.requests[0]!.response = state.requests[2]!.response; },
    (state: ControlState) => { state.requests[4]!.response!.re = requestId(99); },
    (state: ControlState) => { state.requests[0]!.retainUntil = 0; },
    (state: ControlState) => { state.continuations[0]!.interaction = 'waiting'; },
    (state: ControlState) => { state.resources[0]!.root = 'missing'; },
    (state: ControlState) => { state.interactions[0]!.scope = { kind: 'session', session: 'child', root: 'child' }; },
  ])('drops inconsistent control rows individually without quarantining the file', async mutate => {
    const input = fixture(); mutate(input);
    const before = structuredClone(input);
    const repaired = await expectRepairedStore(input);
    expect(repaired.sessions.map(session => session.id)).toContain('root');
    expect(input).toEqual(before);
  });

  it('drops a session whose parent is missing together with its dependent rows', async () => {
    const input = fixture(); input.sessions[1]!.parent = 'missing';
    const repaired = await expectRepairedStore(input);
    expect(repaired.sessions.map(session => session.id)).toEqual(['root']);
    expect(repaired.requests.every(request => request.session !== 'child')).toBe(true);
  });

  it('rejects unknown state fields', async () => {
    const base = parseControlState(fixture());
    expect(() => parseControlState({ ...base, fabricatedOptions: {} })).toThrow(ControlStateValidationError);
    await expectQuarantinedStore({ ...base, sessions: [{ ...base.sessions[0]!, fabricatedOptions: {} }, ...base.sessions.slice(1)] } as ControlState);
  });

  it('rejects lossy or executable non-JSON values without leaking diagnostics', () => {
    const getter = { calls: 0 };
    const accessor = fixture();
    Object.defineProperty(accessor, 'secret', { enumerable: true, get: () => { getter.calls++; return 'sensitive'; } });
    const cyclic = fixture(); Object.assign(cyclic, { loop: cyclic });
    const nonJson = fixture(); Object.assign(nonJson, { lost: undefined });
    const sparse = fixture(); Object.assign(sparse, { sparse: new Array(2) });
    for (const value of [accessor, cyclic, nonJson, sparse]) {
      try { parseControlState(value); throw new Error('Expected rejection'); }
      catch (error) { expect(error).toBeInstanceOf(ControlStateValidationError); expect((error as Error).message).toBe('Control state is invalid.'); }
    }
    expect(getter.calls).toBe(0);
  });

  it('accepts a genuine empty v1 state only when explicitly supplied', () => {
    const input = { version: 1, namespace: 'namespace', agentDir: '/agent', clock: 0,
      sessions: [], requests: [], interactions: [], continuations: [], resources: [] };
    expect(parseControlState(input)).toEqual(input);
  });
});
