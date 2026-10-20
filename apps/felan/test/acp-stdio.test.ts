import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createAcpStdioTransport } from '../src/acp/stdio.js';

function outputOf(stream: PassThrough): string {
  return Buffer.concat(stream.readableLength > 0 ? [stream.read()] : []).toString();
}

describe('ACP stdio transport', () => {
  it('keeps protocol frames on the reserved output and redirects incidental writes', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const diagnostics = new PassThrough();
    const transport = createAcpStdioTransport({ input, output, diagnostics });

    output.write('incidental log\n');
    const writer = transport.stream.writable.getWriter();
    await writer.write({ jsonrpc: '2.0', method: 'test/notification' });
    writer.releaseLock();

    expect(outputOf(output)).toBe('{"jsonrpc":"2.0","method":"test/notification"}\n');
    expect(outputOf(diagnostics)).toBe('incidental log\n');

    transport.restore();
    output.write('ordinary output\n');
    expect(outputOf(output)).toBe('ordinary output\n');
    input.end();
  });

  it('restores output when transport construction fails', () => {
    const output = new PassThrough();
    const diagnostics = new PassThrough();
    const originalWrite = output.write;

    expect(() => createAcpStdioTransport({
      input: {} as never,
      output,
      diagnostics,
    })).toThrow();
    expect(output.write).toBe(originalWrite);
  });
});
