import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LIMITS, requestRetainUntil } from '@felan-ai/session-protocol';
import { CONTROL_LIMITS, type ControlState } from '../src/daemon/control-state.js';
import {
  CONTROL_CONFIGURATION_SNAPSHOT_MAX_BYTES, ControlStateValidationError,
  computeControlConfigurationSnapshotIdentity, parseControlState, validateControlConfigurationSnapshot,
} from '../src/daemon/control-state.js';

import { DaemonControlStore } from '../src/daemon/control-store.js';
import { fixture as storeFixture, fixtures } from './fixtures/registry.js';

afterEach(async () => { for (const dispose of fixtures.splice(0)) await dispose(); });

const NOW = 1_800_000_000_000;
const DIGEST = 'a'.repeat(64);

function configuration() {
  return {
    manager: { package: '@example/manager', version: '1.2.3' },
    services: [{ id: 'example.service', major: 1, use: '@example/manager/provider', options: { enabled: true, budget: 12, labels: ['one', 'two'] } }],
    extensions: [{ package: '@example/feature', grants: ['example.service@1'] }],
    settings: { model: 'provider/model', project: '世界', nested: { exact: null } },
  };
}

function snapshotRow(sessionId = 'root') {
  const snapshot = configuration();
  return { sessionId, snapshot, identity: computeControlConfigurationSnapshotIdentity(snapshot) };
}

function requestId(index: number): string {
  const timestamp = NOW.toString(16).padStart(12, '0');
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7000-8000-${index.toString(16).padStart(12, '0')}`;
}

function fixture(): ControlState {
  const root: ControlState['sessions'][number] = {
    id: 'root', root: 'root', cwd: '/workspace/original', piPath: '/agent/sessions/root.jsonl',
    revision: 42, updatedAt: NOW + 91, state: 'open', residency: 'warm', title: 'Original title 界',
    run: { state: 'waiting', id: 'run', turnId: 'turn' },
    policy: { effective: 'host-default', generation: 7, pending: { target: 'acp-strict', blockers: [{ session: 'root', reason: 'turn', runId: 'run' }] } },
    branch: 'selected-leaf', observedTip: 'newer-tip', model: { provider: 'provider', id: 'model' }, thinking: 'high',
    profile: { source: 'tui', extensionPaths: ['/installed/extension.mjs'],
      extensionConfigOverrides: [{ extensionId: 'feature', source: 'original profile', values: { enabled: true, unknownOptions: { retain: [null, 'original'] } } }] },
    projections: [{ key: 'message:user', updatedAt: NOW + 17, value: { type: 'message', id: 'user', entryId: 'entry', state: 'observed' } },
      { key: 'queue', updatedAt: NOW + 18, value: { type: 'queue', ids: ['queued-turn'], identity: { sha256: DIGEST, bytes: 123 } } }],
  };
  const state: ControlState = {
    version: 1, configurationSnapshots: [], namespace: 'original-namespace', agentDir: '/agent', clock: NOW + 99,
    sessions: [root, { ...root, id: 'child', parent: 'root', cwd: '/workspace/child', piPath: '/agent/sessions/child.jsonl',
      revision: 4, run: { state: 'running', id: 'child-run' }, profile: { source: 'headless' }, projections: [] }],
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

async function expectInvalidStore(input: ControlState): Promise<void> {
  const f = await storeFixture();
  await f.registry.shutdown();
  const path = join(f.store.directory, 'control.json');
  const envelope = JSON.parse(await readFile(path, 'utf8'));
  f.store.close();
  const state = structuredClone(input);
  state.namespace = f.owner.target.namespaceId;
  state.agentDir = f.owner.target.agentDir;
  for (const session of state.sessions) session.piPath = join(state.agentDir, `${session.id}.jsonl`);
  for (const resource of state.resources) if (resource.reference) resource.reference = join(state.agentDir, resource.id);
  envelope.data = state;
  envelope.digest = createHash('sha256').update(JSON.stringify(state)).digest('hex');
  const original = JSON.stringify(envelope);
  await writeFile(path, original, { mode: 0o600 });
  expect(() => new DaemonControlStore(f.owner)).toThrow(/preserve/);
  expect(await readFile(path, 'utf8')).toBe(original);
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
    expect(result.configurationSnapshots).toEqual([]);
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

  it('keeps configuration snapshots alongside sessions without inferring missing snapshots', () => {
    const input = fixture();
    delete input.sessions[1]!.profile;
    const snapshot = snapshotRow();
    const result = parseControlState({ ...input, configurationSnapshots: [snapshot] });
    expect(result.configurationSnapshots).toEqual([snapshot]);
    expect(result.configurationSnapshots!.some(row => row.sessionId === 'child')).toBe(false);
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
  ])('rejects inconsistent control relationships without changing the input', async mutate => {
    const input = fixture(); mutate(input);
    const before = structuredClone(input);
    await expectInvalidStore(input);
    expect(input).toEqual(before);
  });

  it('rejects unknown, duplicate, hash-only or malformed snapshots rather than assigning them to another session', async () => {
    const base = parseControlState(fixture());
    const snapshot = snapshotRow();
    for (const configurationSnapshots of [[{ ...snapshot, sessionId: 'foreign' }], [snapshot, snapshot],
      [{ ...snapshot, identity: { sha256: 'invalid', bytes: 123 } }],
      [{ sessionId: snapshot.sessionId, identity: snapshot.identity }],
      [{ ...snapshot, identity: { ...snapshot.identity, options: {} } }], undefined]) {
      await expectInvalidStore({ ...base, configurationSnapshots } as ControlState);
    }
    expect(() => parseControlState({ ...base, fabricatedOptions: {} })).toThrow(ControlStateValidationError);
  });

  it('hashes canonical UTF-8 JSON with sorted object keys and ordered arrays', () => {
    const first = { z: ['界', 2], a: { b: false, a: null }, '2': 'two', '10': 'ten' };
    const second = { '10': 'ten', '2': 'two', a: { a: null, b: false }, z: ['界', 2] };
    const canonical = '{"10":"ten","2":"two","a":{"a":null,"b":false},"z":["界",2]}';
    const expected = { sha256: createHash('sha256').update(canonical, 'utf8').digest('hex'), bytes: new TextEncoder().encode(canonical).byteLength };
    expect(computeControlConfigurationSnapshotIdentity(first)).toEqual(expected);
    expect(computeControlConfigurationSnapshotIdentity(second)).toEqual(expected);
    expect(computeControlConfigurationSnapshotIdentity({ ...first, z: [2, '界'] })).not.toEqual(expected);
  });

  it('validates, detaches and freezes the full inline configuration without dropping options', () => {
    const original = snapshotRow();
    const captured = structuredClone(original);
    const checked = validateControlConfigurationSnapshot(original);
    const state = parseControlState({ ...parseControlState(fixture()), configurationSnapshots: [original] });
    original.snapshot.services[0]!.options.labels.push('later mutation');
    original.snapshot.settings.project = 'changed';
    expect(checked).toEqual(captured);
    expect(state.configurationSnapshots![0]).toEqual(captured);
    expect(Object.isFrozen(checked.snapshot)).toBe(true);
    expect(parseControlState(state)).toEqual(state);
    expect(state).toEqual({ ...fixture(), configurationSnapshots: [captured] });
  });

  it.each(['payload', 'digest', 'bytes'] as const)('blocks a %s mismatch instead of reconstructing configuration', corruption => {
    const snapshot = snapshotRow();
    if (corruption === 'payload') snapshot.snapshot.services[0]!.options.budget++;
    else if (corruption === 'digest') snapshot.identity = { ...snapshot.identity, sha256: 'b'.repeat(64) };
    else snapshot.identity = { ...snapshot.identity, bytes: snapshot.identity.bytes + 1 };
    expect(() => validateControlConfigurationSnapshot(snapshot)).toThrow('snapshot identity does not match');
  });

  it('enforces UTF-8, nesting, collection and total persisted-state bounds', () => {
    const exact = 'x'.repeat(CONTROL_CONFIGURATION_SNAPSHOT_MAX_BYTES - 2);
    expect(computeControlConfigurationSnapshotIdentity(exact).bytes).toBe(CONTROL_CONFIGURATION_SNAPSHOT_MAX_BYTES);
    for (const value of [exact + 'x', '界'.repeat(Math.ceil(CONTROL_CONFIGURATION_SNAPSHOT_MAX_BYTES / 3)),
      Array.from({ length: LIMITS.catalogEntries + 1 }, () => null)]) {
      expect(() => computeControlConfigurationSnapshotIdentity(value)).toThrow(ControlStateValidationError);
    }
    let nested: unknown = null;
    for (let depth = 0; depth <= LIMITS.depth; depth++) nested = { child: nested };
    expect(() => computeControlConfigurationSnapshotIdentity(nested)).toThrow(ControlStateValidationError);
    const base = parseControlState(fixture());
    let withinPayloadDepth: unknown = null;
    for (let depth = 0; depth < LIMITS.depth - 1; depth++) withinPayloadDepth = { child: withinPayloadDepth };
    const deepRow = { sessionId: 'root', snapshot: withinPayloadDepth, identity: computeControlConfigurationSnapshotIdentity(withinPayloadDepth) };
    expect(() => parseControlState({ ...base, configurationSnapshots: [deepRow] })).toThrow(ControlStateValidationError);
    const count = Math.ceil(CONTROL_LIMITS.bytes / CONTROL_CONFIGURATION_SNAPSHOT_MAX_BYTES);
    const sessions = Array.from({ length: count }, (_, index) => ({ ...base.sessions[0]!, id: `root-${index}`, root: `root-${index}` }));
    const input = { ...base, sessions: [...base.sessions, ...sessions], configurationSnapshots: sessions.map(session => ({
      sessionId: session.id, snapshot: exact, identity: computeControlConfigurationSnapshotIdentity(exact),
    })) };
    expect(Buffer.byteLength(JSON.stringify(input))).toBeGreaterThan(CONTROL_LIMITS.bytes);
    expect(() => parseControlState(input)).toThrow(ControlStateValidationError);
  });

  it('rejects lossy or executable non-JSON values without leaking diagnostics', () => {
    const getter = { calls: 0 };
    const accessor = fixture();
    Object.defineProperty(accessor, 'secret', { enumerable: true, get: () => { getter.calls++; return 'sensitive'; } });
    const cyclic = fixture(); Object.assign(cyclic, { loop: cyclic });
    const nonJson = fixture(); Object.assign(nonJson, { lost: undefined });
    const sparse = fixture(); Object.assign(sparse, { sparse: new Array(2) });
    const oversized = fixture(); Object.assign(oversized, { data: 'x'.repeat(CONTROL_LIMITS.bytes) });
    for (const value of [accessor, cyclic, nonJson, sparse, oversized]) {
      try { parseControlState(value); throw new Error('Expected rejection'); }
      catch (error) { expect(error).toBeInstanceOf(ControlStateValidationError); expect((error as Error).message).toBe('Control state is invalid.'); }
    }
    expect(getter.calls).toBe(0);
  });

  it('accepts a genuine empty v1 state only when explicitly supplied', () => {
    const input = { version: 1, namespace: 'namespace', agentDir: '/agent', clock: 0,
      sessions: [], requests: [], interactions: [], continuations: [], resources: [], configurationSnapshots: [] };
    expect(parseControlState(input)).toEqual(input);
  });
});
