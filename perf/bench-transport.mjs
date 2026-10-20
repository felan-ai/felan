import net from 'node:net';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { join } from 'node:path';
import { dependency } from './lib.mjs';
import { delta } from './fixtures.mjs';

function lines(socket, receive) {
  let buffer = '';
  socket.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (line) receive(line); }
  });
}
async function server(kind, path) {
  const handle = (send, text) => {
    const request = JSON.parse(text);
    if (!request.burst) { send(text + '\n'); return; }
    let batch = '';
    for (let i = 0; i < request.burst; i++) {
      const frame = JSON.stringify(delta(i * 8)) + '\n';
      if (!request.batch) send(frame);
      else { batch += frame; if (batch.length >= 65536) { send(batch); batch = ''; } }
    }
    if (batch) send(batch);
  };
  if (kind === 'ws') {
    const { default: WebSocket } = await dependency('ws');
    const WebSocketServer = WebSocket.WebSocketServer || WebSocket.Server;
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1', perMessageDeflate: false });
    server.on('connection', socket => socket.on('message', data => handle(text => socket.send(text), data.toString())));
    await once(server, 'listening'); process.send({ port: server.address().port });
  } else {
    const server = net.createServer(socket => { socket.on('error', () => {}); socket.setNoDelay(true); lines(socket, text => handle(text => socket.write(text), text)); });
    server.listen(kind === 'unix' ? path : { port: 0, host: '127.0.0.1' });
    await once(server, 'listening'); process.send({ port: kind === 'unix' ? 0 : server.address().port });
  }
  process.on('disconnect', () => process.exit(0));
}
if (process.argv[2] === 'server') await server(process.argv[3], process.argv[4]);

export async function run(ctx) {
  for (const kind of ['unix', 'tcp', 'ws']) await ctx.case(kind, async () => {
    if (kind === 'ws') await dependency('ws');
    const path = join(process.env.HOME, `${kind}.sock`);
    const child = fork(fileURLToPath(import.meta.url), ['server', kind, path, '--runtime', process.env.PROBE_RUNTIME], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let childError = '';
    child.stderr.on('data', data => { childError += data; });
    let socket;
    let timer;
    let waiter;
    let rejectWait;
    const receive = text => { try { waiter?.(text); } catch (error) { rejectWait?.(error); } };
    const fail = error => { rejectWait?.(error); };
    const wait = (send, expected) => new Promise((resolve, reject) => {
      waiter = text => { assert.equal(text, expected, 'Echo payload mismatch'); clearTimeout(timer); waiter = undefined; rejectWait = undefined; resolve(); };
      rejectWait = error => { clearTimeout(timer); waiter = undefined; rejectWait = undefined; reject(error); };
      timer = setTimeout(() => rejectWait?.(new Error(`${kind} response timeout`)), 10000);
      send();
    });
    try {
      const [address] = await Promise.race([once(child, 'message'), once(child, 'exit').then(([code]) => { throw new Error(`Transport server exited ${code}: ${childError}`); })]);
      let send;
      if (kind === 'ws') {
        const { default: WebSocket } = await dependency('ws');
        socket = new WebSocket(`ws://127.0.0.1:${address.port}`, { perMessageDeflate: false });
        await once(socket, 'open');
        socket.on('message', data => { for (const text of data.toString().split('\n')) if (text) receive(text); });
        send = text => socket.send(text);
      } else {
        socket = kind === 'unix' ? net.connect(path) : net.connect(address.port, '127.0.0.1');
        socket.setNoDelay(true); await once(socket, 'connect');
        lines(socket, receive); send = text => socket.write(text + '\n');
      }
      socket.on('error', fail);
      socket.on('close', () => fail(new Error(`${kind} closed before response`)));
      const rtts = [];
      for (let i = -50; i < (ctx.quick ? 200 : 3000); i++) {
        const payload = '{"id":"echo","text":"hello"}';
        const start = performance.now(); await wait(() => send(payload), payload);
        if (i >= 0) rtts.push(performance.now() - start);
      }
      ctx.samples(`${kind}.RTT`, rtts);
      const count = ctx.quick ? 5000 : 50000;
      for (const batch of [false, true]) {
        const start = performance.now();
        await new Promise((resolve, reject) => {
          let received = 0;
          waiter = text => {
            assert.deepEqual(JSON.parse(text), delta(received * 8), 'Burst delta mismatch');
            if (++received === count) { clearTimeout(timer); waiter = undefined; rejectWait = undefined; resolve(); }
          };
          rejectWait = reject; timer = setTimeout(() => reject(new Error(`Burst timed out after ${received}/${count} frames`)), 10000);
          send(JSON.stringify({ burst: count, batch }));
        });
        const elapsed = performance.now() - start;
        const label = `${kind}.burst.${batch ? 'batched' : 'per-frame'}`;
        ctx.value(label, elapsed, 'ms', { frames: count });
        ctx.value(`${label}.throughput`, count / elapsed * 1000, 'frames/s');
      }
    } finally {
      clearTimeout(timer); socket?.terminate?.(); socket?.destroy?.();
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
      }
    }
  });
}
