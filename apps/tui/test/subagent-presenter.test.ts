import { describe, expect, it, vi } from 'vitest';
import { attachLocalSubagentPresenter } from '../src/subagents/presenter.js';
import type { LocalSubagentHost, LocalSubagentView } from '../src/subagents/host.js';

describe('local subagent presenter', () => {
  it('shows status from the host subscription', () => {
    const view: LocalSubagentView = {
      agentId: 'child',
      parentSessionId: 'parent',
      rootSessionId: 'root',
      type: 'general',
      description: 'implement',
      status: 'running',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const subscribe = vi.fn((listener: (records: readonly LocalSubagentView[]) => void) => {
      listener([view]);
      return vi.fn();
    });
    let updateHost!: (host: LocalSubagentHost) => void;
    const unsubscribeRuntime = vi.fn();
    const setExtensionStatus = vi.fn();

    const detach = attachLocalSubagentPresenter(
      {
        localSubagentHost: { subscribe } as unknown as LocalSubagentHost,
        subscribeLocalSubagentHost: (listener) => {
          updateHost = listener;
          return unsubscribeRuntime;
        },
      },
      { setExtensionStatus },
    );

    expect(setExtensionStatus).toHaveBeenCalledWith(
      'felan-subagents',
      '1 active · implement: running',
    );
    detach();
    expect(unsubscribeRuntime).toHaveBeenCalledOnce();
    expect(setExtensionStatus).toHaveBeenLastCalledWith('felan-subagents', undefined);
  });

  it('rebinds once when the runtime creates a replacement host', () => {
    const firstDetach = vi.fn();
    const firstSubscribe = vi.fn(() => firstDetach);
    const secondDetach = vi.fn();
    const secondSubscribe = vi.fn(() => secondDetach);
    const first = { subscribe: firstSubscribe } as unknown as LocalSubagentHost;
    const second = { subscribe: secondSubscribe } as unknown as LocalSubagentHost;
    let updateHost!: (host: LocalSubagentHost) => void;
    const unsubscribeRuntime = vi.fn();
    const setExtensionStatus = vi.fn();
    const detach = attachLocalSubagentPresenter({
      localSubagentHost: first,
      subscribeLocalSubagentHost: (listener) => {
        updateHost = listener;
        return unsubscribeRuntime;
      },
    }, { setExtensionStatus });

    updateHost(second);
    updateHost(second);

    expect(firstDetach).toHaveBeenCalledOnce();
    expect(secondSubscribe).toHaveBeenCalledOnce();
    detach();
    updateHost(first);

    expect(unsubscribeRuntime).toHaveBeenCalledOnce();
    expect(secondDetach).toHaveBeenCalledOnce();
    expect(firstSubscribe).toHaveBeenCalledOnce();
    expect(setExtensionStatus).toHaveBeenLastCalledWith('felan-subagents', undefined);
  });
});
