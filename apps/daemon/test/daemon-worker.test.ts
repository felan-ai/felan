import { describe, expect, it, vi } from 'vitest';
import type { ModelRuntime } from '@felan-ai/agent-core';
import type { ProviderWorkerRequest } from '../src/daemon/provider.js';
import type { SessionRegistry } from '../src/daemon/registry.js';
import { createRegisteredWorkerLauncher } from '../src/daemon/worker.js';

function fixture() {
  const canonical = { provider: 'provider', id: 'model', baseUrl: 'https://canonical.invalid' };
  const session = { prompt: vi.fn(async () => {}), abort: vi.fn(async () => {}), dispose: vi.fn(),
    bindExtensions: vi.fn(async () => {}), setActiveToolsByName: vi.fn(), getActiveToolNames: () => ['read'], messages: [], thinkingLevel: 'medium' };
  const registry = { assertNewWork: vi.fn(), assertDispatch: vi.fn(),
    openWorker: vi.fn(async () => ({ sessionId: 'worker', runtime: { session } })),
    close: vi.fn(async () => {}), projection: () => ({ setOrigin: vi.fn() }),
    runWorker: vi.fn(async (_id: string, work: () => Promise<void>) => work()) };
  const models = { getAvailable: vi.fn(async () => [canonical]) };
  const open = createRegisteredWorkerLauncher(registry as unknown as SessionRegistry, { id: 'parent', root: 'parent' }, models as unknown as ModelRuntime,
    [{ provider: 'provider', id: 'model' }]);
  const request = { runtime: {}, sessionManager: {}, settingsManager: {}, model: { provider: 'provider', id: 'model' }, allowedTools: ['read'] } as ProviderWorkerRequest;
  return { canonical, session, registry, models, open, request };
}

describe('admitted worker launcher', () => {
  it('re-resolves the model and opens only through the canonical registry', async () => {
    const f = fixture();
    const worker = await f.open({ ...f.request, model: { ...f.request.model, baseUrl: 'https://caller.invalid' } as ProviderWorkerRequest['model'] });
    expect(f.registry.openWorker).toHaveBeenCalledWith('parent', expect.objectContaining({ model: f.canonical, allowedTools: ['read'] }));
    await worker.bindExtensions({ mode: 'print' });
    expect(f.session.bindExtensions).toHaveBeenCalledWith({ mode: 'print' });
    worker.setActiveToolsByName(['read']);
    expect(() => worker.setActiveToolsByName(['bash'])).toThrow('cannot widen');
    await worker.prompt('work');
    expect(f.registry.runWorker).toHaveBeenCalledWith('worker', expect.any(Function));
    await worker.dispose();
    expect(f.registry.close).toHaveBeenCalledWith('worker');
    expect(f.session.dispose).not.toHaveBeenCalled();
  });

  it('rejects unavailable or disallowed models before canonical registration', async () => {
    const f = fixture();
    await expect(f.open({ ...f.request, model: { provider: 'other', id: 'model' } })).rejects.toThrow('outside the current scope');
    expect(f.registry.openWorker).not.toHaveBeenCalled();
    f.models.getAvailable.mockResolvedValueOnce([]);
    await expect(f.open(f.request)).rejects.toThrow('unavailable');
    expect(f.registry.openWorker).not.toHaveBeenCalled();
  });

  it('closes a newly registered worker if cancellation wins during opening', async () => {
    const f = fixture();
    const control = new AbortController();
    f.registry.openWorker.mockImplementationOnce(async () => {
      control.abort();
      return { sessionId: 'worker', runtime: { session: f.session } };
    });
    await expect(f.open({ ...f.request, signal: control.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.registry.close).toHaveBeenCalledWith('worker');
    expect(f.session.prompt).not.toHaveBeenCalled();
  });
});
