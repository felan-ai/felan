import { AsyncLocalStorage } from 'node:async_hooks';

const benchmark = new AsyncLocalStorage();
const contract = { id: 'felan.session-runtime', major: 1, key: 'felan.session-runtime@1' };

export function withBenchmarkRuntime(context, run) {
  return benchmark.run(context, run);
}

export default {
  provides: [contract],
  requires: [{ id: 'felan.runtime', major: 1 }],
  async create(context) {
    const state = benchmark.getStore();
    if (!state) throw new Error('Benchmark runtime requires an active scenario');
    const { composition, scenario, mode, activation } = state;
    const runtimeService = context.services.get(composition.core.HOST_RUNTIME_SERVICE);
    const local = composition.sessionRuntime.createLocalSessionRuntime({ runtimeService,
      runtimeFactory: request => runtimeService.create(request.cwd, { ...request, pathAccess: 'host' }),
      initializeProcess: async () => ({ diagnostics: [], assertConfiguration: () => [] }),
    });
    const runtime = { ...local,
      secretStorage: {
        async read() { return undefined; },
        async write() { throw new Error('Benchmark secret storage is disabled'); },
        async remove() { throw new Error('Benchmark secret storage is disabled'); },
      },
      async prepare(request) {
        const prepared = await local.prepare(request);
        return { ...prepared, options: { ...prepared.options, skillPaths: [],
          inlineExtensions: [...(prepared.options.inlineExtensions ?? []), {
            name: 'codemode-scenario-tools',
            factory(pi) {
              for (const tool of scenario.tools) pi.registerTool(tool);
              pi.on('session_start', () => {
                try {
                  const active = pi.getActiveTools();
                  if (active.includes('codemode') !== (mode !== 'off')) throw new Error('Felan config did not activate the expected code mode');
                  const tools = scenario.tools.length ? scenario.tools.map(tool => tool.name) : ['read', 'write', 'edit', 'bash'];
                  pi.setActiveTools([...tools, ...active.filter(name => name === 'codemode')]);
                  activation.ready = true;
                } catch (error) {
                  activation.error = error;
                }
              });
            },
          }],
        } };
      },
    };
    return { implementations: [{ contract, value: runtime }], async dispose() {} };
  },
};
