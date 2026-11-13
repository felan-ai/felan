import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { DaemonSecurityError } from './native-ownership.js';

const HELLO = Buffer.from([0x46, 0x4c, 0x4e, 0x48, 1]);
function proof(secret: Buffer, role: 'client' | 'server', first: Buffer, second: Buffer): Buffer {
  return createHmac('sha256', secret).update(`felan-ipc-v1 ${role}`).update(first).update(second).digest();
}

export function clientHandshake(stream: Duplex, secret: Buffer, timeoutMs = 2_000): Promise<void> { return handshake(stream, secret, 'client', timeoutMs); }
export function serverHandshake(stream: Duplex, secret: Buffer, timeoutMs = 2_000): Promise<void> { return handshake(stream, secret, 'server', timeoutMs); }

function handshake(stream: Duplex, secret: Buffer, role: 'client' | 'server', timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false; let completing = false; let challenged = false; let received = 0;
    let expected = role === 'client' ? 64 : 37;
    let clientNonce = role === 'client' ? randomBytes(32) : Buffer.alloc(0);
    let serverNonce = Buffer.alloc(0);
    const input = Buffer.alloc(64);
    const timeout = setTimeout(() => finish(new DaemonSecurityError('unavailable', 'IPC authentication timed out.')), timeoutMs);
    function finish(error?: Error, remainder?: Buffer) {
      if (settled) return;
      settled = true; clearTimeout(timeout);
      stream.off('readable', onReadable); stream.off('error', onError); stream.off('end', onEnd); stream.off('close', onEnd);
      if (error) { stream.destroy(); reject(error); }
      else { if (remainder?.length) stream.unshift(remainder); resolve(); }
    }
    function onError() { finish(new DaemonSecurityError('unavailable', 'IPC authentication connection failed.')); }
    function onEnd() { finish(new DaemonSecurityError('unavailable', 'IPC authentication ended before completion.')); }
    function write(bytes: Buffer, done?: () => void) {
      stream.write(bytes, error => { if (error) onError(); else done?.(); });
    }
    function onReadable() {
      if (settled || completing) return;
      try {
        let chunk: Buffer | null;
        while ((chunk = stream.read() as Buffer | null) !== null) {
          if (!Buffer.isBuffer(chunk)) throw new DaemonSecurityError('invalid_handshake', 'IPC authentication requires binary frames.');
          const used = Math.min(chunk.length, expected - received);
          chunk.copy(input, received, 0, used); received += used;
          if (received < expected) continue;
          const remainder = chunk.subarray(used);
          if (role === 'server' && !challenged) {
            if (remainder.length || !input.subarray(0, 5).equals(HELLO)) throw new DaemonSecurityError('invalid_handshake', 'Invalid or oversized IPC authentication hello.');
            clientNonce = Buffer.from(input.subarray(5, 37)); serverNonce = randomBytes(32);
            challenged = true; received = 0; expected = 32;
            write(Buffer.concat([serverNonce, proof(secret, 'server', clientNonce, serverNonce)]));
            continue;
          }
          const actual = role === 'client' ? input.subarray(32, 64) : input.subarray(0, 32);
          if (role === 'client') serverNonce = Buffer.from(input.subarray(0, 32));
          const wanted = role === 'client' ? proof(secret, 'server', clientNonce, serverNonce) : proof(secret, 'client', serverNonce, clientNonce);
          if (!timingSafeEqual(actual, wanted)) throw new DaemonSecurityError('forbidden', 'IPC authentication proof did not match.');
          completing = true;
          if (role === 'client') write(proof(secret, 'client', serverNonce, clientNonce), () => finish(undefined, remainder));
          else finish(undefined, remainder);
          return;
        }
      } catch (error) { finish(error as Error); }
    }
    if (secret.length !== 32 || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
      finish(new DaemonSecurityError('invalid_handshake', 'IPC authentication requires a 32-byte secret and a bounded deadline.')); return;
    }
    stream.on('readable', onReadable); stream.once('error', onError); stream.once('end', onEnd); stream.once('close', onEnd);
    if (stream.destroyed || stream.readableEnded) { onEnd(); return; }
    try { if (role === 'client') write(Buffer.concat([HELLO, clientNonce])); onReadable(); }
    catch (error) { finish(error as Error); }
  });
}
