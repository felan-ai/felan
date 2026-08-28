import type { ExtensionContext } from '@felan-ai/agent-core';
import { describe, expect, it, vi } from 'vitest';
import { createSavingsCommandExtension } from '../src/savings-command.js';

describe('savings command extension', () => {
  it('is a hidden host-owned inline extension that registers only savings', async () => {
    const registerCommand = vi.fn();
    const extension = createSavingsCommandExtension({} as never);

    expect(extension).toMatchObject({
      name: '@felan-ai/felan/savings',
      hidden: true,
    });
    if (typeof extension === 'function') throw new Error('Expected a named inline extension');
    await extension.factory({ registerCommand } as never);

    expect(registerCommand).toHaveBeenCalledWith('savings', expect.any(Object));
    expect(registerCommand).not.toHaveBeenCalledWith('gain', expect.anything());
  });

  it('queries the requested scope and reports invalid arguments', async () => {
    const query = vi.fn(async () => ({
      scope: 'project' as const,
      bucketCount: 0,
      calls: 0,
      baselineCostUsd: 0,
      actualCostUsd: 0,
      savedCostUsd: 0,
      hasUnpricedMeasurements: false,
      buckets: [],
      diagnostics: [],
    }));
    const notify = vi.fn();
    const registerCommand = vi.fn();
    const extension = createSavingsCommandExtension({ query } as never);
    if (typeof extension === 'function') throw new Error('Expected a named inline extension');
    await extension.factory({ registerCommand } as never);
    const command = registerCommand.mock.calls[0]![1] as {
      handler: (args: string, context: ExtensionContext) => Promise<void>;
    };
    const context = { ui: { notify } } as unknown as ExtensionContext;

    await command.handler('project', context);
    expect(query).toHaveBeenCalledWith({ scope: 'project' });
    expect(notify).toHaveBeenLastCalledWith(expect.stringContaining('Felan estimated savings — project'), 'info');

    await command.handler('unexpected', context);
    expect(query).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenLastCalledWith('Usage: /savings [project|all|details]', 'warning');
  });
});
