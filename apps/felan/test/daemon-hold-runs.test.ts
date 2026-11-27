import type { Context } from '@felan-ai/agent-core';
import { afterEach, expect, it, vi } from 'vitest';
import { RUN_CONTINUED_TEXT } from '../../daemon/src/daemon/run-hold.js';
import { cleanups, harness, session, text, TEST_TIMEOUT_MS } from './fixtures/hold-runs.js';

const WAIT_MS = 30_000;

/** Tools a request offers; system messages add and remove them as the transcript goes on. */
function availableTools(context: Context): string[] {
  const tools = new Set<string>();
  for (const message of context.messages) {
    if (message.role !== 'system') continue;
    for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
  }
  return [...tools];
}
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it('holds two runs and a subagent at their step ends, restarts, and continues each run once with its queued messages', async () => {
  const h = await harness(['root-a', 'child-a', 'root-b']);
  let client = await h.connect();
  expect(await client.control('host.status')).toMatchObject({ stopModes: ['drain', 'force', 'hold'], holdsRuns: true });
  const a = await session(client, h.cwd, 'ROOT-A start'); const b = await session(client, h.cwd, 'ROOT-B start');
  await vi.waitFor(async () => expect(await h.log()).toEqual(['child-a', 'root-a', 'root-b']), { timeout: WAIT_MS });
  const child = h.store().sessionMetadatas().find(row => row.parent === a)!.id;
  expect(await client.request('steer', { text: 'STEER-B' }, { session: b })).toMatchObject({ outcome: 'accepted' });
  expect(await client.request('follow_up', { text: 'FOLLOW-B' }, { session: b })).toMatchObject({ outcome: 'accepted' });
  const runs = Object.fromEntries([a, b, child].map(id => [id, h.store().sessionMetadata(id).run.id]));

  // Requirement 1: each run, the subagent's too, finishes the tool call of its step and holds before its next request.
  const held = await h.hold(client);
  expect(held).toMatchObject({ outcome: 'accepted', state: 'draining', held: { action: 'restart', runs: 3 }, holdsRuns: true });
  expect(h.model.calls.map(call => `${call.who}:${call.turn}`).sort()).toEqual(['child-a:0', 'root-a:0', 'root-b:0']);
  // Requirement 2: a versioned continue record exists for each held run before held is reported.
  expect(h.store().heldRuns().map(record => [record.version, record.session]).sort()).toEqual([a, b, child].map(id => [1, id]).sort());
  expect(h.store().heldRuns().find(record => record.session === b)!.queue.map(item => [item.kind, item.message.content])).toEqual([
    ['steer', [{ type: 'text', text: 'STEER-B' }]], ['follow_up', [{ type: 'text', text: 'FOLLOW-B' }]]]);
  // Requirement 4: held runs stay running to clients.
  for (const id of [a, b, child]) expect(h.store().sessionMetadata(id).run).toMatchObject({ id: runs[id], state: 'running' });

  await client.close();
  await h.restart();
  client = await h.connect();
  await vi.waitFor(() => {
    for (const id of [a, b, child]) expect(h.store().sessionMetadata(id).run.state).toBe('idle');
    expect(h.model.calls.some(call => call.who === 'root-a' && text(call.context.messages.at(-1)!).includes('Execution completion'))).toBe(true);
  }, { timeout: WAIT_MS });
  await vi.waitFor(() => expect(h.store().sessionMetadata(a).run.state).toBe('idle'), { timeout: WAIT_MS });

  // No tool call ran twice: each command logged once and each tool call ID appears once in its transcript.
  expect(await h.log()).toEqual(['child-a', 'root-a', 'root-b']);
  for (const id of [a, b, child]) {
    const ids = h.state.service.registry.binding(id)!.runtime.session.sessionManager.getEntries()
      .flatMap(entry => entry.type === 'message' && entry.message.role === 'assistant' ? entry.message.content.filter(part => part.type === 'toolCall').map(part => part.id) : []);
    expect(new Set(ids).size).toBe(ids.length);
  }
  // B and the subagent continued under their held run IDs and the parent received the subagent's completion.
  expect(h.store().sessionMetadata(b).run.id).toBe(runs[b]);
  expect(h.store().sessionMetadata(child)).toMatchObject({ run: { id: runs[child] }, execution: { outcome: 'completed' } });
  // No queued message was lost or repeated: the steer reached the continued step and the follow-up the request after it.
  const bCalls = h.model.calls.filter(call => call.who === 'root-b');
  expect(bCalls.map(call => call.turn)).toEqual([0, 1, 2]);
  const said = (index: number, value: string) => bCalls[index]!.context.messages.filter(message => text(message).includes(value)).length;
  expect([said(1, 'STEER-B'), said(1, 'FOLLOW-B'), said(2, 'STEER-B'), said(2, 'FOLLOW-B')]).toEqual([1, 0, 1, 1]);
  // The continued step starts with the host's notice, once, as the only message the restart added.
  expect(bCalls[1]!.context.messages.filter(message => text(message) === RUN_CONTINUED_TEXT)).toHaveLength(1);
  expect(bCalls[2]!.context.messages.filter(message => text(message) === RUN_CONTINUED_TEXT)).toHaveLength(1);
  // The subagent kept its instructions and the task created before the hold survived the restore.
  const childCalls = h.model.calls.filter(call => call.who === 'child-a');
  expect(childCalls.map(call => call.turn)).toEqual([0, 1]);
  // Its turn limit of 2 counted the held step, so the continued request is its last: no tools and the summary instruction.
  expect(availableTools(childCalls[0]!.context)).toContain('bash');
  expect(availableTools(childCalls[1]!.context)).toEqual([]);
  expect(childCalls[1]!.context.messages.filter(message => text(message).includes('Stop using tools.'))).toHaveLength(1);
  const listed = h.model.calls.find(call => call.who === 'root-a' && call.turn === 2)!.context.messages.at(-1)!;
  expect(text(listed)).toContain('held task');
}, TEST_TIMEOUT_MS);
