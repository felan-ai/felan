import type { AgentRuntime } from '@felan-ai/agent-core';
import { BROWSER_SETUP_PRESENTER, BrowserSetupRequestSchema } from '@felan-ai/ext-browser/presentation';
import { INSIGHTS_REPORT_PRESENTER, parseInsightsReportRequest } from '@felan-ai/ext-insights/view';
import { parseSchema } from '@felan-ai/session-protocol';
import type { InteractionBroker } from '../daemon/broker.js';

export async function openHostUrl(runtime: AgentRuntime, value: string, signal: AbortSignal): Promise<void> {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || /[\u0000-\u0020\u007f]/u.test(value)) throw new Error('Invalid browser URL.');
  await openTarget(runtime, url.toString(), signal);
}

export function prepareHostInteraction(options: {
  runtime: AgentRuntime;
  broker: InteractionBroker;
  assertCurrent(): void;
  assertOwnsPath(path: string): unknown;
}, interactionId: string, client: string, signal: AbortSignal): () => Promise<void> {
  options.assertCurrent(); signal.throwIfAborted();
  const request = options.broker.presentationRequest(interactionId, client);
  if (request.kind === 'oauth') return () => openHostUrl(options.runtime, request.url, signal);
  if (request.kind !== 'custom') throw new Error('This interaction cannot open an external application.');
  if (request.presenter.id === INSIGHTS_REPORT_PRESENTER.id && request.presenter.version === INSIGHTS_REPORT_PRESENTER.version) {
    const { path } = parseInsightsReportRequest(request.data); options.assertOwnsPath(path);
    return () => openTarget(options.runtime, path, signal);
  } else if (request.presenter.id === BROWSER_SETUP_PRESENTER.id && request.presenter.version === BROWSER_SETUP_PRESENTER.version) {
    if (process.platform !== 'darwin') throw new Error('Chrome setup is not supported on this platform.');
    const { applicationPath } = parseSchema(BrowserSetupRequestSchema, request.data);
    return async () => {
      const result = await options.runtime.exec('/usr/bin/open', ['-a', applicationPath, 'chrome://inspect/#remote-debugging'], { signal, timeout: 5000, maxOutputBytes: 4096 });
      if (result.code !== 0 || result.killed || result.truncated) throw new Error('Chrome setup could not be opened.');
    };
  } else throw new Error('This presenter cannot open an external application.');
}

async function openTarget(runtime: AgentRuntime, value: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const command = process.platform === 'darwin' ? '/usr/bin/open' : process.platform === 'linux' ? 'xdg-open' : undefined;
  if (!command) throw new Error('Opening local applications is unsupported on this platform.');
  const result = await runtime.exec(command, process.platform === 'darwin' ? ['--', value] : [value], { signal, timeout: 5000, maxOutputBytes: 4096 });
  signal.throwIfAborted();
  if (result.code !== 0 || result.killed || result.truncated) throw new Error('The local application could not be opened.');
}
