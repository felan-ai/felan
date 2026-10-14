import { describe, expect, it, vi } from 'vitest';
import { createRuntimeDependenciesPort } from '../src/daemon/runtime-dependencies.js';

function fixture(available = true) {
  const setup = {
    dependency: vi.fn(() => ({ label: 'Trusted dependency', description: 'Install the reviewed package.' })),
    installApprovedDependency: vi.fn(async () => ({ status: 'installed' as const })),
  };
  const broker = {
    canPresent: vi.fn(() => available),
    request: vi.fn(async () => ({ state: 'answered' as const, answer: { kind: 'dependency' as const, approved: true } })),
  };
  return { setup, broker, port: createRuntimeDependenciesPort(setup, broker) };
}

describe('runtime dependency kernel port', () => {
  it('requires a host-scoped local-console confirmation before dispatch', async () => {
    const { setup, broker, port } = fixture();
    expect(await port.install({ id: 'markitdown' })).toEqual({ status: 'installed' });
    expect(broker.canPresent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'dependency', dependency: 'markitdown' }), { kind: 'host' });
    expect(broker.request).toHaveBeenCalledWith(expect.objectContaining({ kind: 'dependency' }), { kind: 'host' }, {});
    expect(setup.installApprovedDependency).toHaveBeenCalledWith('markitdown', undefined);
  });

  it('does not ask remote clients or dispatch when no local console is eligible', async () => {
    const { setup, broker, port } = fixture(false);
    expect((await port.install({ id: 'rtk' })).status).toBe('unavailable');
    expect(broker.request).not.toHaveBeenCalled();
    expect(setup.installApprovedDependency).not.toHaveBeenCalled();
  });

  it('requires approval and honors preflight cancellation', async () => {
    const { setup, broker, port } = fixture();
    broker.request.mockResolvedValueOnce({ state: 'answered', answer: { kind: 'dependency', approved: false } });
    expect((await port.install({ id: 'rtk' })).status).toBe('cancelled');
    const controller = new AbortController(); controller.abort();
    expect((await port.install({ id: 'rtk' }, { signal: controller.signal })).status).toBe('cancelled');
    expect(broker.request).toHaveBeenCalledTimes(1);
    expect(setup.installApprovedDependency).not.toHaveBeenCalled();
  });

  it('never dispatches an unregistered dependency or discloses backend errors', async () => {
    const { setup, broker, port } = fixture();
    setup.dependency.mockImplementation(() => { throw new Error('private backend sentinel'); });
    const result = await port.install({ id: 'unknown' });
    expect(result.status).toBe('unavailable');
    expect(JSON.stringify(result)).not.toContain('private backend sentinel');
    expect(broker.request).not.toHaveBeenCalled(); expect(setup.installApprovedDependency).not.toHaveBeenCalled();
  });
});
