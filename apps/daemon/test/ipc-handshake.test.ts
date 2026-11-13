import { createHmac, randomBytes } from 'node:crypto';
import { duplexPair, type Duplex } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonLineDecoder } from '@felan-ai/session-protocol';
import { clientHandshake, serverHandshake } from '../src/daemon/ipc-handshake.js';

const streams: Duplex[] = [];
const hello = (nonce = randomBytes(32)) => Buffer.concat([Buffer.from('FLNH'), Buffer.from([1]), nonce]);
function pair() { const peers = duplexPair(); streams.push(...peers); for (const peer of peers) peer.on('error', () => {}); return peers; }
function digest(secret: Buffer, role: string, first: Buffer, second: Buffer) { return createHmac('sha256', secret).update(`felan-ipc-v1 ${role}`).update(first).update(second).digest(); }
function nextData(stream: Duplex): Promise<Buffer> { return new Promise(resolve => stream.once('data', resolve)); }
afterEach(() => { for (const stream of streams.splice(0)) stream.destroy(); });

describe('mutual IPC authentication', () => {
  it('authenticates both peers and leaves protocol readers able to receive bytes', async () => {
    const [client, server] = pair(); const secret = randomBytes(32);
    await Promise.all([clientHandshake(client, secret), serverHandshake(server, secret)]);
    const serverData = nextData(server); const clientData = nextData(client);
    client.write('request\n'); server.write('response\n');
    expect((await serverData).toString()).toBe('request\n'); expect((await clientData).toString()).toBe('response\n');
  });

  it('uses the specified nonce order and preserves protocol bytes coalesced with the final proof', async () => {
    const [client, server] = pair(); const secret = randomBytes(32); const nonce = randomBytes(32);
    const challenge = nextData(client); const authenticated = serverHandshake(server, secret);
    client.write(hello(nonce));
    const bytes = await challenge; expect(bytes).toHaveLength(64);
    const serverNonce = bytes.subarray(0, 32);
    expect(bytes.subarray(32)).toEqual(digest(secret, 'server', nonce, serverNonce));
    client.write(Buffer.concat([digest(secret, 'client', serverNonce, nonce), Buffer.from('{"control":1}\n')]));
    await authenticated;
    expect(new JsonLineDecoder().push(await nextData(server))).toEqual([{ control: 1 }]);
  });

  it('preserves bytes following the server proof for the client protocol reader', async () => {
    const [client, server] = pair(); const secret = randomBytes(32); const serverNonce = randomBytes(32);
    const first = nextData(server); const authenticated = clientHandshake(client, secret);
    const bytes = await first; expect(bytes).toHaveLength(37); expect(bytes.subarray(0, 5)).toEqual(Buffer.from([0x46, 0x4c, 0x4e, 0x48, 1]));
    const nonce = bytes.subarray(5); const clientProof = nextData(server);
    server.write(Buffer.concat([serverNonce, digest(secret, 'server', nonce, serverNonce), Buffer.from('ready\n')]));
    expect(await clientProof).toEqual(digest(secret, 'client', serverNonce, nonce));
    await authenticated; expect((await nextData(client)).toString()).toBe('ready\n');
  });

  it.each(['client', 'server'] as const)('accepts fragmented frames as the %s', async role => {
    const [client, server] = pair(); const secret = randomBytes(32);
    async function fragments(stream: Duplex, bytes: Buffer) {
      for (const byte of bytes) { stream.write(Buffer.from([byte])); await new Promise<void>(resolve => setImmediate(resolve)); }
    }
    if (role === 'server') {
      const nonce = randomBytes(32); const challenge = nextData(client); const authenticated = serverHandshake(server, secret);
      await fragments(client, hello(nonce)); const serverNonce = (await challenge).subarray(0, 32);
      await fragments(client, digest(secret, 'client', serverNonce, nonce)); await authenticated;
    } else {
      const first = nextData(server); const authenticated = clientHandshake(client, secret);
      const nonce = (await first).subarray(5); const serverNonce = randomBytes(32); const final = nextData(server);
      await fragments(server, Buffer.concat([serverNonce, digest(secret, 'server', nonce, serverNonce)]));
      expect(await final).toEqual(digest(secret, 'client', serverNonce, nonce)); await authenticated;
    }
  });

  it.each(['client', 'server'] as const)('rejects a wrong %s secret without admitting the peer', async wrong => {
    const [client, server] = pair(); const secret = randomBytes(32);
    const results = await Promise.allSettled([clientHandshake(client, wrong === 'client' ? randomBytes(32) : secret, 50), serverHandshake(server, wrong === 'server' ? randomBytes(32) : secret, 50)]);
    expect(results[0]).toMatchObject({ status: 'rejected', reason: { code: 'forbidden' } });
    expect(results[1]).toMatchObject({ status: 'rejected', reason: { code: 'unavailable' } });
    expect(client.destroyed).toBe(true); expect(server.destroyed).toBe(true);
  });

  it.each(['garbage', 'version', 'oversized'] as const)('rejects a %s hello and destroys the stream', async kind => {
    const [client, server] = pair(); const authenticated = serverHandshake(server, randomBytes(32));
    const bytes = hello();
    if (kind === 'garbage') bytes[0] = 0;
    if (kind === 'version') bytes[4] = 2;
    client.write(kind === 'oversized' ? Buffer.concat([bytes, Buffer.alloc(65_536)]) : bytes);
    await expect(authenticated).rejects.toMatchObject({ code: 'invalid_handshake' }); expect(server.destroyed).toBe(true);
  });

  it('rejects a truncated hello without waiting for the deadline', async () => {
    const [client, server] = pair(); const authenticated = serverHandshake(server, randomBytes(32));
    client.end(hello().subarray(0, 36));
    await expect(authenticated).rejects.toMatchObject({ code: 'unavailable' }); expect(server.destroyed).toBe(true);
  });

  it.each(['client', 'server'] as const)('bounds the %s handshake deadline', async role => {
    const [client, server] = pair(); const peer = role === 'client' ? client : server;
    await expect((role === 'client' ? clientHandshake : serverHandshake)(peer, randomBytes(32), 20)).rejects.toMatchObject({ code: 'unavailable' });
    expect(peer.destroyed).toBe(true);
  });

  it('rejects a forged client proof after a valid server challenge', async () => {
    const [client, server] = pair(); const challenge = nextData(client); const authenticated = serverHandshake(server, randomBytes(32));
    client.write(hello()); await challenge; client.write(Buffer.alloc(32));
    await expect(authenticated).rejects.toMatchObject({ code: 'forbidden' }); expect(server.destroyed).toBe(true);
  });

  it.each(['challenge', 'proof'] as const)('rejects a truncated %s', async phase => {
    const [client, server] = pair(); const secret = randomBytes(32);
    if (phase === 'challenge') {
      const first = nextData(server); const authenticated = clientHandshake(client, secret);
      await first; server.end(Buffer.alloc(63)); await expect(authenticated).rejects.toMatchObject({ code: 'unavailable' }); expect(client.destroyed).toBe(true);
    } else {
      const challenge = nextData(client); const authenticated = serverHandshake(server, secret);
      client.write(hello()); await challenge; client.end(Buffer.alloc(31)); await expect(authenticated).rejects.toMatchObject({ code: 'unavailable' }); expect(server.destroyed).toBe(true);
    }
  });

  it('destroys a stream on transport errors and invalid configuration', async () => {
    const [client, server] = pair(); const authenticated = clientHandshake(client, randomBytes(32));
    client.destroy(new Error('synthetic transport failure'));
    await expect(authenticated).rejects.toMatchObject({ code: 'unavailable' });
    await expect(serverHandshake(server, Buffer.alloc(31))).rejects.toMatchObject({ code: 'invalid_handshake' }); expect(server.destroyed).toBe(true);
  });
});
