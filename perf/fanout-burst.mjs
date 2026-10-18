import net from 'node:net';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';
import { built, sleep } from './lib.mjs';
import { delta } from './fixtures.mjs';

export async function run(ctx) {
  const { SessionFanout } = await built('apps/daemon/dist/daemon/fanout.js');
  const { JsonLineDecoder } = await built('packages/session-protocol/dist/index.js');
  for (const count of [500, 1023, 1025, 3000]) await ctx.case(`burst.${count}`, async () => {
    const path = join(process.env.HOME, 'fanout.sock');
    let remote; let fanout; let reason = 'open'; let text = ''; let frameCount = 0; let decodingError;
    const decoder = new JsonLineDecoder();
    const server = net.createServer(socket => {
      remote = socket;
      socket.on('error', () => {});
      fanout = new SessionFanout({ write: (data, done) => socket.write(data, done), close: why => { reason = why; socket.destroy(); } });
      socket.on('drain', () => fanout.drain());
      for (let i = 0; i < count; i++) fanout.send(delta(i, 'x'));
    });
    let client;
    const start = performance.now();
    try {
      server.listen(path); await once(server, 'listening');
      client = net.connect(path);
      client.on('error', error => { decodingError = error; });
      client.on('data', data => {
        try { for (const frame of decoder.push(data)) { frameCount++; assert.equal(frame.stream.offset, text.length); text += frame.text; } } catch (error) { decodingError = error; }
      });
      const deadline = performance.now() + 3000;
      while (text.length < count && reason === 'open' && !decodingError && performance.now() < deadline) await sleep(5);
      if (decodingError) throw decodingError;
      decoder.finish();
      assert.ok(['open', 'resync_required'].includes(reason), `Fanout closed with ${reason}`);
      if (reason === 'open') assert.equal(text.length, count, 'Fanout did not deliver all text');
      ctx.value(`burst.${count}`, performance.now() - start, 'ms', { deltas: count, frames: frameCount, characters: text.length, reason, pendingFrames: fanout.pendingFrames });
    } finally {
      client?.destroy(); remote?.destroy(); fanout?.close();
      await new Promise(resolve => server.close(resolve));
      try { unlinkSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  });
}
