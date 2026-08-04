import type { LocalSubagentHost, LocalSubagentView } from './host.js';

interface StatusTarget {
  setExtensionStatus?(key: string, text: string | undefined): void;
}

interface LocalSubagentRuntimePresentation {
  readonly localSubagentHost: LocalSubagentHost;
  subscribeLocalSubagentHost(listener: (host: LocalSubagentHost) => void): () => void;
}

export function attachLocalSubagentPresenter(
  runtime: LocalSubagentRuntimePresentation,
  target: StatusTarget,
): () => void {
  if (!target.setExtensionStatus) return () => {};
  let activeHost: LocalSubagentHost | undefined;
  let detachHost = () => {};
  let detached = false;
  const bind = (host: LocalSubagentHost) => {
    if (detached || host === activeHost) return;
    detachHost();
    activeHost = host;
    detachHost = host.subscribe((records) => {
      target.setExtensionStatus?.('felan-subagents', renderStatus(records));
    });
  };
  bind(runtime.localSubagentHost);
  const detachRuntime = runtime.subscribeLocalSubagentHost(bind);
  return () => {
    if (detached) return;
    detached = true;
    detachRuntime();
    detachHost();
    target.setExtensionStatus?.('felan-subagents', undefined);
  };
}

function renderStatus(records: readonly LocalSubagentView[]): string | undefined {
  if (records.length === 0) return undefined;
  const active = records.filter((record) => record.status === 'queued' || record.status === 'running');
  const latest = records.at(-1)!;
  return `${active.length} active · ${latest.description}: ${latest.status}`;
}
