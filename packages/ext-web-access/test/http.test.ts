import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  combinedSignal,
  readJsonResponse,
  readResponseBytes,
  readResponseText,
} from '../src/http.js';

describe('bounded HTTP response readers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts the exact byte limit and cancels a multi-chunk overflow', async () => {
    const exact = new Response(new Uint8Array([1, 2, 3, 4]));
    await expect(readResponseBytes(exact, 4)).resolves.toEqual(new Uint8Array([1, 2, 3, 4]));

    let cancelReason: unknown;
    const overflow = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5]));
      },
      cancel(reason) {
        cancelReason = reason;
      },
    }));
    await expect(readResponseBytes(overflow, 4)).rejects.toThrow('Response exceeds the 4-byte limit');
    expect(cancelReason).toBeUndefined();
  });

  it('propagates mid-stream cancellation and cancels the response body', async () => {
    const cancellation = new Error('caller stopped the read');
    const controller = new AbortController();
    let bodyCancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new Uint8Array([1, 2, 3]));
      },
      cancel(reason) {
        bodyCancelled = reason === cancellation;
      },
    }));

    const read = readResponseBytes(response, 10, controller.signal);
    controller.abort(cancellation);

    await expect(read).rejects.toBe(cancellation);
    expect(bodyCancelled).toBe(true);
  });

  it('shares caller and deterministic timeout signals across text and JSON reads', async () => {
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
    const caller = new AbortController();
    const signal = combinedSignal(caller.signal, 30_000);
    const reason = new DOMException('timed out', 'TimeoutError');
    timeout.abort(reason);

    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe(reason);
    await expect(readResponseText(new Response('private text'), 100, signal)).rejects.toBe(reason);
    await expect(readJsonResponse(new Response('{}'), 100, 'Provider', signal)).rejects.toBe(reason);

    await expect(readJsonResponse(new Response('{'), 100, 'Provider'))
      .rejects.toThrow('Provider returned invalid JSON');
  });
});
