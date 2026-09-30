export function imageFormat(bytes: Uint8Array): { mimeType: string; extension: string } {
  const data = Buffer.from(bytes);
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { mimeType: 'image/png', extension: 'png' };
  }
  if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) {
    return { mimeType: 'image/jpeg', extension: 'jpg' };
  }
  if (['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString('ascii'))) {
    return { mimeType: 'image/gif', extension: 'gif' };
  }
  if (data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { mimeType: 'image/webp', extension: 'webp' };
  }
  if (data.length >= 14 && data[0] === 66 && data[1] === 77) {
    return { mimeType: 'image/bmp', extension: 'bmp' };
  }
  throw new Error('Unsupported image data. Use PNG, JPEG, GIF, WebP or BMP raster images.');
}

export function decodeImage(data: string, mimeType: string) {
  if (typeof data !== 'string' || !data || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(data)) {
    throw new Error('Invalid image data.');
  }
  const bytes = Buffer.from(data, 'base64');
  if (bytes.toString('base64') !== data) throw new Error('Invalid image data.');
  const format = imageFormat(bytes);
  if (format.mimeType !== mimeType) throw new Error('Image MIME type does not match its data.');
  return { bytes, ...format };
}
