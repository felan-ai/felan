import { ndJsonStream, type Stream } from '@agentclientprotocol/sdk';
import { Readable, type Writable } from 'node:stream';

export interface AcpStdioOptions {
  readonly input?: Readable;
  readonly output?: Writable;
  readonly diagnostics?: Writable;
}

export interface AcpStdioTransport {
  readonly stream: Stream;
  restore(): void;
}

export function createAcpStdioTransport(options: AcpStdioOptions = {}): AcpStdioTransport {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const diagnostics = options.diagnostics ?? process.stderr;
  const outputWrite = output.write;
  const writeProtocol = outputWrite.bind(output);
  const guardedWrite = ((
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean => {
    const encoding = typeof encodingOrCallback === 'string' ? encodingOrCallback : undefined;
    const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
    try {
      const diagnosticChunk = typeof chunk === 'string' && encoding !== undefined
        ? Buffer.from(chunk, encoding)
        : chunk;
      diagnostics.write(diagnosticChunk, done);
    } catch (error) {
      done?.(error instanceof Error ? error : new Error(String(error)));
    }
    return true;
  }) as typeof output.write;
  output.write = guardedWrite;
  try {
    const protocolOutput = new WritableStream<Uint8Array>({
      write: (chunk) => new Promise<void>((resolve, reject) => {
        try {
          writeProtocol(chunk, (error) => {
            if (error) reject(error);
            else resolve();
          });
        } catch (error) {
          reject(error);
        }
      }),
    });
    const protocolInput = Readable.toWeb(input) as ReadableStream<Uint8Array>;

    return {
      stream: ndJsonStream(protocolOutput, protocolInput),
      restore() {
        if (output.write === guardedWrite) output.write = outputWrite;
      },
    };
  } catch (error) {
    if (output.write === guardedWrite) output.write = outputWrite;
    throw error;
  }
}
