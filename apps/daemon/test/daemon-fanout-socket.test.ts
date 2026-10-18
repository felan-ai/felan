import { setImmediate as nextTurn } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { JsonLineDecoder, type TextStreamEvent } from '@felan-ai/session-protocol';
import type { SessionFanout } from '../src/daemon/fanout.js';
import { connectLocalIpc } from '../src/daemon/ipc.js';
import { SessionServer } from '../src/daemon/server.js';
import { TestHostConfiguration } from './fixtures/host-services.js';
import { serverFixture } from './fixtures/server.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function connected() {
  const fixture = await serverFixture();
  const server = new SessionServer({ registry: fixture.registry,
    configuration: new TestHostConfiguration({ definitions: [], assertCurrent: () => fixture.registry.assertAdmission() }),
    models: fixture.root.runtime.session.modelRuntime, version: 'fixture' });
  cleanups.push(async () => { server.close(); await fixture.dispose(); });
  await server.start();
  const socket = await connectLocalIpc(fixture.owner.target);
  cleanups.push(async () => { socket.destroy(); });
  const connections = (server as unknown as { connections: Set<{ out: SessionFanout }> }).connections;
  await vi.waitFor(() => expect(connections.size).toBe(1));
  return { socket, fanout: [...connections][0]!.out };
}

it('delivers 3000 synchronous text deltas over a Unix socket without disconnecting', async () => {
  const { socket, fanout } = await connected();
  const decoder = new JsonLineDecoder(); const frames: TextStreamEvent[] = [];
  const text = 'x😀\n'; const expected = text.repeat(3000);
  const received = new Promise<void>((resolve, reject) => {
    socket.on('error', reject);
    socket.on('data', chunk => {
      try {
        frames.push(...decoder.push(chunk) as unknown as TextStreamEvent[]);
        if (frames.reduce((length, frame) => length + frame.text.length, 0) === expected.length) resolve();
      } catch (error) { reject(error); }
    });
    socket.on('end', () => reject(new Error('Connection ended before the burst was received.')));
  });
  for (let index = 0; index < 3000; index++) expect(fanout.send({ v: 1, session: 'session',
    stream: { id: 'stream', message: 'message', kind: 'assistant', offset: index * 3 }, text })).toBe(true);
  expect(fanout.pendingFrames).toBe(1);
  await received; await nextTurn();
  expect(frames).toHaveLength(1); expect(frames.map(frame => frame.text).join('')).toBe(expected);
  expect(frames[0]!.stream.offset).toBe(0);
  expect(fanout.closed).toBe(false); expect(socket.destroyed).toBe(false);
  expect(fanout.pendingFrames).toBe(0); expect(fanout.pendingBytes).toBe(0);
  expect(() => decoder.finish()).not.toThrow();
});

it('gracefully completes an in-flight frame before EOF when queued frames overflow', async () => {
  const { socket, fanout } = await connected();
  const close = vi.spyOn(fanout, 'close'); const decoder = new JsonLineDecoder(); const frames: unknown[] = [];
  const finished = new Promise<void>((resolve, reject) => {
    socket.on('error', reject);
    socket.on('data', chunk => {
      try { frames.push(...decoder.push(chunk)); } catch (error) { reject(error); }
    });
    socket.on('end', () => {
      try { decoder.finish(); resolve(); } catch (error) { reject(error); }
    });
  });
  socket.pause();
  const large = { text: 'x'.repeat(4 * 1024 * 1024) }; const afterSend = vi.fn();
  expect(fanout.send(large, afterSend)).toBe(true); await nextTurn();
  expect(fanout.pendingFrames).toBe(1); expect(afterSend).not.toHaveBeenCalled();
  for (let index = 0; index < 1024 && !fanout.closed; index++) fanout.send({ index });
  expect(close).toHaveBeenCalledWith('resync_required'); expect(fanout.closed).toBe(true);
  expect(afterSend).toHaveBeenCalledOnce(); expect(fanout.pendingBytes).toBe(0);
  socket.resume(); await finished;
  expect(frames).toEqual([large]); expect(() => decoder.finish()).not.toThrow();
  expect(afterSend).toHaveBeenCalledOnce();
});
