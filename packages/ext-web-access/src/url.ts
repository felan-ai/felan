export function canonicalUrlKey(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.hostname = url.hostname.toLowerCase();
    if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) {
      url.port = '';
    }
    url.hash = '';
    return url.toString();
  } catch {
    return rawUrl;
  }
}
