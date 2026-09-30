import { describe, expect, it } from 'vitest';
import { decodeImage, imageFormat } from '../src/image-data.js';

describe('image signatures', () => {
  it.each([
    [[137, 80, 78, 71, 13, 10, 26, 10], 'image/png', 'png'],
    [[255, 216, 255, 224], 'image/jpeg', 'jpg'],
    [Buffer.from('GIF89a'), 'image/gif', 'gif'],
    [Buffer.from('GIF87a'), 'image/gif', 'gif'],
    [Buffer.from('RIFF0000WEBP'), 'image/webp', 'webp'],
    [Buffer.from('BM000000000000'), 'image/bmp', 'bmp'],
  ] as const)('recognizes supported raster signature %j', (data, mimeType, extension) => {
    const bytes = Buffer.from(data);
    expect(imageFormat(bytes)).toEqual({ mimeType, extension });
    expect(decodeImage(bytes.toString('base64'), mimeType)).toEqual({ bytes, mimeType, extension });
  });

  it.each(['', '<svg xmlns="http://www.w3.org/2000/svg"/>', 'not an image', 'GIF', 'RIFF0000WAVE', 'BM'])('rejects unsupported and truncated signatures', text => {
    expect(() => imageFormat(Buffer.from(text))).toThrow('Unsupported image data');
  });
});
