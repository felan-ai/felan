import { describe, expect, it, vi } from 'vitest';
import { readBrowserImage } from '../src/image.js';
import { BrowserTestRuntime, VALID_PNG_HEADER } from './test-runtime.js';

const resizeImageMock = vi.hoisted(() => vi.fn());
const GENERATED_SCREENSHOT = '/session/browser/screenshots/screenshot-00000000-0000-4000-8000-000000000000.png';

vi.mock('@felan-ai/agent-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@felan-ai/agent-core')>()),
  resizeImage: resizeImageMock,
}));

describe('browser screenshot image bridge', () => {
  it('validates, bounds, resizes, and returns native image content', async () => {
    resizeImageMock.mockResolvedValueOnce({
      data: 'aGVsbG8=',
      mimeType: 'image/png',
      originalWidth: 3_000,
      originalHeight: 2_000,
      width: 2_000,
      height: 1_333,
      wasResized: true,
    });
    const runtime = new BrowserTestRuntime();
    runtime.files.set(GENERATED_SCREENSHOT, VALID_PNG_HEADER);

    const result = await readBrowserImage(runtime, GENERATED_SCREENSHOT, true);

    expect(result).toMatchObject({
      image: { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
      details: {
        path: GENERATED_SCREENSHOT,
        delivered: true,
        width: 2_000,
        height: 1_333,
        wasResized: true,
      },
    });
    expect(resizeImageMock).toHaveBeenCalledWith(
      VALID_PNG_HEADER,
      'image/png',
      expect.objectContaining({ maxWidth: 2_000, maxHeight: 2_000, maxBytes: 4 * 1024 * 1024 }),
    );
  });

  it('does not read empty paths or images for text-only models', async () => {
    const runtime = new BrowserTestRuntime();
    runtime.files.set(GENERATED_SCREENSHOT, VALID_PNG_HEADER);

    await expect(readBrowserImage(runtime, '', true)).resolves.toMatchObject({
      details: { delivered: false, reason: expect.stringContaining('empty') },
    });
    await expect(readBrowserImage(runtime, GENERATED_SCREENSHOT, false)).resolves.toMatchObject({
      details: { delivered: false, reason: expect.stringContaining('does not support') },
    });
    expect(runtime.calls).toHaveLength(0);
  });

  it('rejects unsupported bytes and turns decoder failures into a text fallback', async () => {
    const runtime = new BrowserTestRuntime();
    runtime.files.set(GENERATED_SCREENSHOT, new TextEncoder().encode('not an image'));
    await expect(readBrowserImage(runtime, GENERATED_SCREENSHOT, true)).resolves.toMatchObject({
      details: { delivered: false, reason: expect.stringContaining('supported') },
    });

    runtime.files.set(GENERATED_SCREENSHOT, VALID_PNG_HEADER);
    resizeImageMock.mockRejectedValueOnce(new Error('decode failed\u0000'));
    await expect(readBrowserImage(runtime, GENERATED_SCREENSHOT, true)).resolves.toMatchObject({
      details: { delivered: false, reason: expect.stringContaining('decode failed') },
    });
  });
});
