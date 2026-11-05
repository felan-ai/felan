import { mkdtemp, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { SessionManager } from '@felan-ai/agent-core';
import { daemonMemoryFixture, memoryPreference } from './fixtures/daemon-memory.js';

const cleanups: Array<() => Promise<void>> = [];
let root: string;
beforeAll(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'dm-'))); });
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const f = await daemonMemoryFixture(root);
  cleanups.push(f.dispose);
  expect(Object.keys(f.initial.pending)).toHaveLength(5);
  expect(f.initial.processed).toEqual({});
  await vi.waitFor(() => expect(f.dream.calls).toHaveLength(4), { timeout: 10_000 });
  await f.dream.entered;
  const listed = f.service.registry.listed();
  expect(listed.map(session => session.id).sort()).toEqual(f.checkpoints.map(checkpoint => checkpoint.sessionId).sort());
  expect(listed.every(session => session.state === 'closed' && session.residency === 'evicted')).toBe(true);
  expect(listed.every(session => f.service.registry.binding(session.id) === undefined)).toBe(true);
  expect(await f.service.registry.activeWork()).toBe(0);
  expect(await f.service.server['activeWork']()).toBe(1);
  const active = (await f.store.readControl()).activeAttempt!;
  expect(active.runId).toBeTypeOf('string');
  expect(f.service.registry.options.store.findSessionMetadata(active.runId)).toBeUndefined();
  expect(f.service.registry.binding(active.runId)).toBeUndefined();
  expect(f.dream.manifest!.sessions.map(session => session.checkpoint.sessionId).sort())
    .toEqual(f.checkpoints.map(checkpoint => checkpoint.sessionId).sort());
  expect(SessionManager.open(f.checkpoints[4]!.sessionFile!).getCwd()).toBe(f.subdirectory);
  const results = f.dream.calls.flatMap(context => context.messages.filter(message => message.role === 'toolResult'));
  expect(results.length).toBeGreaterThan(5);
  expect(results.every(result => !result.isError)).toBe(true);
  for (const [index] of f.dream.manifest!.sessions.entries()) {
    const transcript = results.find(result => result.toolCallId === `memory-${index + 1}-read`);
    expect(transcript).toBeDefined();
    expect(transcript!.content.filter(item => item.type === 'text').map(item => item.text).join('\n'))
      .toContain(`Remember this preference: ${memoryPreference}`);
  }
  expect(await readFile(join(f.store.currentDirectory, 'summary.md'), 'utf8')).not.toContain(memoryPreference);
  return f;
}

it('publishes memory through an unregistered daemon worker with no session loaded', async () => {
  const f = await fixture();
  f.dream.release();
  await vi.waitFor(async () => expect(await f.store.readControl()).toMatchObject({ lastOutcome: { status: 'success' } }), { timeout: 10_000 });
  expect(await readFile(join(f.store.currentDirectory, 'summary.md'), 'utf8')).toContain(memoryPreference);
  const page = await readFile(join(f.store.currentDirectory, 'pages', 'preferences', 'maintenance.md'), 'utf8');
  for (const checkpoint of f.checkpoints) expect(page).toContain(`- session:${checkpoint.sessionId}`);
  const state = await f.store.status();
  expect(state.pending).toEqual({});
  expect(Object.keys(state.processed).sort()).toEqual(f.checkpoints.map(checkpoint => checkpoint.sessionId).sort());
  for (const checkpoint of f.checkpoints) expect(state.processed[checkpoint.sessionId]!.checkpoint).toEqual(checkpoint);
  expect(await f.store.pendingAcceptedUpdates()).toBe(0);
  const control = await f.store.readControl();
  await vi.waitFor(async () => {
    const run = JSON.parse(await readFile(join(f.store.projectDirectory, 'runs', control.lastOutcome!.runId, 'manifest.json'), 'utf8'));
    expect(run).toMatchObject({ sessionId: control.lastOutcome!.runId, status: 'completed', model: { provider: 'offline', id: 'fixture-mini' } });
  }, { timeout: 10_000 });
  expect(f.service.registry.listed().map(session => session.id).sort()).toEqual(f.checkpoints.map(checkpoint => checkpoint.sessionId).sort());
  expect(f.service.registry.options.store.findSessionMetadata(control.lastOutcome!.runId)).toBeUndefined();
  expect(f.service.registry.binding(control.lastOutcome!.runId)).toBeUndefined();
  expect(await f.service.registry.activeWork()).toBe(0);
}, 30_000);

it('records a cancelled attempt and preserves pending evidence when the daemon drains mid-dream', async () => {
  const f = await fixture();
  expect(await f.service.requestStop('stop', 'drain')).toMatchObject({ outcome: 'accepted' });
  await vi.waitFor(() => expect(f.service.lifecycle.state).toBe('stopped'), { timeout: 10_000 });
  expect(await f.service.stopped).toBe('stop');
  expect(f.dream.aborted).toBe(true);
  const control = await f.store.readControl();
  expect(control).toMatchObject({ lastOutcome: { status: 'cancelled' }, consecutiveFailures: 0 });
  expect(control.activeAttempt).toBeUndefined();
  expect(control.nextRetryAt).toBeUndefined();
  const run = JSON.parse(await readFile(join(f.store.projectDirectory, 'runs', control.lastOutcome!.runId, 'manifest.json'), 'utf8'));
  expect(run).toMatchObject({ status: 'cancelled' });
  const state = await f.store.status();
  expect(state.pending).toEqual(f.initial.pending);
  expect(state.processed).toEqual({});
  expect(await f.store.pendingAcceptedUpdates()).toBe(5);
  expect(await readFile(join(f.store.currentDirectory, 'summary.md'), 'utf8')).not.toContain(memoryPreference);
}, 30_000);
