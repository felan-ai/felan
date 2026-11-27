import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { RUN_CONTINUED_TEXT } from '../../daemon/src/daemon/run-hold.js';
import { cleanups, harness, session, text, TEST_TIMEOUT_MS } from './fixtures/hold-runs.js';

const WAIT_MS = 30_000;
const NOTICE = 'Background process reached terminal status';
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

// The felan providers fix the agent directory per process, so this daemon needs its own test file.
it('delivers a background command\'s finish notice that a held run queued after held to the run the next daemon continues', async () => {
  const h = await harness(['root-c']);
  cleanups.push(() => writeFile(join(h.cwd, 'c-job.go'), '').catch(() => {}));
  let client = await h.connect();
  const c = await session(client, h.cwd, 'ROOT-C start');
  await vi.waitFor(async () => expect(await h.log()).toEqual(['root-c']), { timeout: WAIT_MS });
  expect(await h.hold(client)).toMatchObject({ outcome: 'accepted', held: { runs: 1 } });

  // The background command finishes while the run is parked, so Pi only queues its notice as a steer.
  await writeFile(join(h.cwd, 'c-job.go'), '');
  const agent = h.state.service.registry.binding(c)!.runtime.session.agent;
  await vi.waitFor(() => expect(agent.hasQueuedMessages()).toBe(true), { timeout: WAIT_MS });
  await client.close();
  await h.restart();
  client = await h.connect();

  await vi.waitFor(() => {
    expect(h.store().sessionMetadata(c).run).toMatchObject({ state: 'idle' });
    expect(h.model.calls.some(call => call.who === 'root-c' && call.context.messages.some(message => text(message).includes(NOTICE)))).toBe(true);
  }, { timeout: WAIT_MS });
  // The next daemon continued the held run rather than interrupting it, and the notice reached the model once.
  const calls = h.model.calls.filter(call => call.who === 'root-c');
  expect(calls[1]!.context.messages.filter(message => text(message) === RUN_CONTINUED_TEXT)).toHaveLength(1);
  expect(await h.log()).toEqual(['root-c']);
  const notices = h.state.service.registry.binding(c)!.runtime.session.sessionManager.getEntries()
    .filter(entry => entry.type === 'custom_message' && entry.customType === 'felan-background-bash-completion');
  expect(notices).toHaveLength(1);
  expect(calls.at(-1)!.context.messages.filter(message => text(message).includes(NOTICE))).toHaveLength(1);
}, TEST_TIMEOUT_MS);
