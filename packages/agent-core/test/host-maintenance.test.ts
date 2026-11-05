import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  HOST_MAINTENANCE_SERVICE,
  HOST_MODELS_SERVICE,
  createFelanServiceRegistry,
  type HostMaintenance,
  type HostSessionsSelector,
  type HostWorkerLauncher,
  type ModelReference,
  type ModelRuntime,
  type ModelsService,
  type SessionsHistory,
} from '../src/index.js';

describe('host maintenance contracts', () => {
  it('exports versioned maintenance and models contracts', () => {
    expect(HOST_MAINTENANCE_SERVICE).toMatchObject({ id: 'felan.host.maintenance', major: 1, key: 'felan.host.maintenance@1' });
    expect(HOST_MODELS_SERVICE).toMatchObject({ id: 'felan.host.models', major: 1, key: 'felan.host.models@1' });
    expect(Object.isFrozen(HOST_MAINTENANCE_SERVICE)).toBe(true);
    expect(Object.isFrozen(HOST_MODELS_SERVICE)).toBe(true);
    const services = createFelanServiceRegistry();
    expectTypeOf(services.get(HOST_MAINTENANCE_SERVICE)).toEqualTypeOf<HostMaintenance | undefined>();
    expectTypeOf(services.get(HOST_MODELS_SERVICE)).toEqualTypeOf<ModelsService | undefined>();
  });

  it('reuses host worker, model runtime and history-only session types', () => {
    expectTypeOf<HostSessionsSelector>().toEqualTypeOf<
      { readonly kind: 'project'; readonly cwd: string } | { readonly kind: 'all' }
    >();
    expectTypeOf<HostMaintenance>().toEqualTypeOf<{
      readonly agentDir: string;
      readonly modelRuntime: ModelRuntime;
      readonly signal: AbortSignal;
      allowedModels(signal?: AbortSignal): Promise<readonly ModelReference[] | undefined>;
      sessions(selector: HostSessionsSelector): SessionsHistory;
      readonly openWorker: HostWorkerLauncher;
    }>();
  });
});
