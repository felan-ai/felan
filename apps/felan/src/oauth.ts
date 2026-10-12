export async function openLocalOAuthUrl(value: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (/[\u0000-\u0020\u007f]/u.test(value)) throw new Error('Invalid OAuth authorization URL.');
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password) {
    throw new Error('Invalid OAuth authorization URL.');
  }
  const { default: open } = await import('open');
  signal.throwIfAborted();
  await open(url.href);
  signal.throwIfAborted();
}
