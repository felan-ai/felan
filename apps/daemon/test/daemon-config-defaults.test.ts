import { expect, it, vi } from 'vitest';
import { SessionCommands } from '../src/daemon/commands.js';
import type { HostConfiguration } from '../src/daemon/host-services.js';
import { requestId, serverFixture } from './fixtures/server.js';

it('supplies the attached session model when resolving global configuration defaults', async () => {
  const f = await serverFixture();
  try {
    const get = vi.fn(async () => ({ writable: true, values: {} }));
    const commands = new SessionCommands({ registry: f.registry, configuration: { get } as unknown as HostConfiguration,
      models: { getAvailable: async () => [] }, invalidated() {} });
    await commands.read({ v: 1, id: requestId(), op: 'config.get', session: f.root.sessionId, params: { scope: 'global' } });
    expect(get).toHaveBeenCalledWith('global', f.root.runtime.session.model);
    await commands.read({ v: 1, id: requestId(), op: 'config.get', params: { scope: 'global' } });
    expect(get).toHaveBeenLastCalledWith('global', undefined);
  } finally { await f.dispose(); }
});
