import type { AgentRuntime, ExtensionUi, UiForm } from '@felan-ai/agent-core';

export type OpenReportOutcome = 'opened' | 'declined' | 'unavailable' | 'failed';

const OPEN_ACTION = 'open';

function confirmation(path: string): UiForm {
  return {
    title: 'Open insights report',
    fallback: `Open ${path} with the default application on this host?`,
    input: { fields: [] },
    actions: [
      { id: OPEN_ACTION, label: 'Open report', target: 'element', outcome: 'submit' },
      { id: 'cancel', label: 'Cancel', target: 'element', outcome: 'cancel' },
    ],
  };
}

/** Opens the report only after a local-console confirmation, using literal argv on the host running the daemon. */
export async function openReportOnHost(options: {
  readonly ui: Pick<ExtensionUi, 'canRequest' | 'request'>;
  readonly runtime: AgentRuntime;
  readonly path: string;
  readonly signal: AbortSignal;
}): Promise<OpenReportOutcome> {
  const { ui, runtime, path, signal } = options;
  const form = confirmation(path);
  if (!ui.canRequest(form, { audience: 'host' })) return 'unavailable';
  const result = await ui.request(form, { signal, audience: 'host' });
  if (result.state !== 'answered' || result.answer.actionId !== OPEN_ACTION) return 'declined';
  signal.throwIfAborted();
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
  const opened = await runtime.exec(command, [path]);
  return opened.code === 0 ? 'opened' : 'failed';
}
