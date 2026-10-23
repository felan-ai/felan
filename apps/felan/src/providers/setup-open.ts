import type { AgentRuntime } from '@felan-ai/agent-core';
import type { Interaction } from '@felan-ai/session-protocol';

export async function openHostUrl(runtime: AgentRuntime, value: string, signal: AbortSignal): Promise<void> {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || /[\u0000-\u0020\u007f]/u.test(value)) throw new Error('Invalid browser URL.');
  await openTarget(runtime, url.toString(), signal);
}

export function prepareLocalInteractionOpen(_options: {
  runtime: AgentRuntime;
  assertOwnsPath(path: string): unknown;
}, _request: Interaction['request'], signal: AbortSignal): () => Promise<void> {
  signal.throwIfAborted();
  throw new Error('This interaction cannot open an external application.');
}

async function openTarget(runtime: AgentRuntime, value: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const command = process.platform === 'darwin' ? '/usr/bin/open' : process.platform === 'linux' ? 'xdg-open' : undefined;
  if (!command) throw new Error('Opening local applications is unsupported on this platform.');
  const result = await runtime.exec(command, process.platform === 'darwin' ? ['--', value] : [value], { signal, timeout: 5000, maxOutputBytes: 4096 });
  signal.throwIfAborted();
  if (result.code !== 0 || result.killed || result.truncated) throw new Error('The local application could not be opened.');
}

export async function openBrowserSetup(runtime: AgentRuntime, applicationPath: string, signal: AbortSignal): Promise<void> {
  if (runtime.kind !== 'host' || !applicationPath.startsWith('/') || /[\u0000-\u001f\u007f]/u.test(applicationPath)) throw new Error('Chrome setup requires a valid local application.');
  signal.throwIfAborted();
  if (process.platform !== 'darwin') throw new Error('Chrome setup is not supported on this platform.');
  const result = await runtime.exec('/usr/bin/open', ['-a', applicationPath, 'chrome://inspect/#remote-debugging'], { signal, timeout: 5000, maxOutputBytes: 4096 });
  signal.throwIfAborted();
  if (result.code !== 0 || result.killed || result.truncated) throw new Error('Chrome setup could not be opened.');
}
