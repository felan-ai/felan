import type { Socket } from 'node:net';
import { JsonLineDecoder, LIMITS, encodeFrame } from '@felan-ai/session-protocol';
import { connectLocalIpc } from '@felan-ai/daemon/client';
import type { ResolvedDaemonTarget } from '@felan-ai/daemon/client';

export interface TransportReceiver {
  frame(value: unknown): void;
  closed(reason: 'transport_lost' | 'invalid_frame' | 'overflow'): void;
}

export interface ClientTransport {
  send(value: unknown): void;
  close(): void;
}

export type TransportConnector = (receiver: TransportReceiver) => Promise<ClientTransport>;

export function socketTransport(socket: Socket, receiver: TransportReceiver): ClientTransport {
  const decoder = new JsonLineDecoder();
  let closed = false;
  function close(reason: Parameters<TransportReceiver['closed']>[0]) {
    if (closed) return;
    closed = true;
    socket.destroy();
    receiver.closed(reason);
  }
  socket.on('data', (chunk: Buffer) => {
    try {
      for (const frame of decoder.push(chunk)) {
        if (closed) break;
        receiver.frame(frame);
      }
    } catch { close('invalid_frame'); }
  });
  socket.on('error', () => close('transport_lost'));
  socket.on('end', () => {
    try { decoder.finish(); close('transport_lost'); }
    catch { close('invalid_frame'); }
  });
  socket.on('close', () => close('transport_lost'));
  return {
    send(value) {
      if (closed) throw new Error('Transport is closed');
      const frame = encodeFrame(value);
      if (socket.writableLength + frame.byteLength > LIMITS.unsentBytes) {
        close('overflow');
        throw new Error('Transport output limit exceeded');
      }
      socket.write(frame);
    },
    close: () => close('transport_lost'),
  };
}

export function localConnector(target: ResolvedDaemonTarget): TransportConnector {
  return async receiver => socketTransport(await connectLocalIpc(target), receiver);
}
