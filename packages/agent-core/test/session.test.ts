import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSessionRuntime,
  type AgentSessionHost,
  type FelanExtension,
  type StreamFunction,
} from '../src/index.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createAgentCoreSession,
  createAgentCoreSessionRuntimeFactory,
  createRuntimeCodingTools,
} from '../src/index.js';
import { TestAgentRuntime } from '../src/test-agent-runtime.js';

const temporaryPaths: string[] = [];

afterEach(async () => {
  delete (globalThis as { ambientSessionExtension?: boolean }).ambientSessionExtension;
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe('Agent Core session composition', () => {
  it('composes an inactive session, preserves app settings, and wraps streaming last', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent-dir');
    await mkdir(cwd, { recursive: true });
    const installMarker = join(root, 'startup-install-ran');
    const fakeNpm = join(root, 'fake-npm.mjs');
    await writeFile(fakeNpm, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(installMarker)}, 'ran');`);
    const ambientExtension = join(root, 'ambient-extension.js');
    await writeFile(
      ambientExtension,
      'globalThis.ambientSessionExtension = true; export default () => {};',
    );

    const appSettings = SettingsManager.inMemory({
      packages: ['@felan-ai/ambient-package'],
      extensions: [ambientExtension],
      npmCommand: [process.execPath, fakeNpm],
    });
    const modelRuntime = await createModelRuntime(agentDir);
    const sessionManager = SessionManager.inMemory(cwd);
    const runtime = new TestAgentRuntime(cwd);
    const order: string[] = [];
    let wrappedInvocations = 0;
    const extension: FelanExtension = () => {
      order.push('extension factory');
    };
    const host = createHost((original) => {
      order.push('stream wrapped');
      return ((model, context, options) => {
        wrappedInvocations += 1;
        return original(model, context, options);
      }) satisfies StreamFunction;
    });
    const appTool = { ...createRuntimeCodingTools(runtime)[0]!, name: 'app-tool', label: 'app-tool' };

    const result = await createAgentCoreSession({
      applicationKind: 'cloud',
      runtime,
      host,
      extensionPackages: ['@felan-ai/listed'],
      importExtension: async (packageName) => {
        order.push(`import ${packageName}`);
        return { default: extension };
      },
      modelRuntime,
      settingsManager: appSettings,
      sessionManager,
      agentDir,
      customTools: [appTool],
      systemPrompt: 'Portable system prompt',
    });

    expect(order).toEqual([
      'import @felan-ai/listed',
      'extension factory',
      'stream wrapped',
    ]);
    expect(result.session.settingsManager).toBe(appSettings);
    expect(result.session.sessionManager).toBe(sessionManager);
    expect(result.session.modelRuntime).toBe(modelRuntime);
    expect(result.session.agent.state.isStreaming).toBe(false);
    expect(result.session.agent.state.messages).toEqual([]);
    expect(wrappedInvocations).toBe(0);
    expect(result.extensionsResult.extensions.map((loaded) => loaded.path)).toEqual([
      '<inline:@felan-ai/listed>',
    ]);
    expect(result.session.agent.state.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'read',
      'bash',
      'edit',
      'write',
      'grep',
      'find',
      'ls',
      'app-tool',
    ]));
    expect((globalThis as { ambientSessionExtension?: boolean }).ambientSessionExtension).toBeUndefined();
    await expect(fileExists(installMarker)).resolves.toBe(false);

    result.session.dispose();
  });

  it('provides a Pi 0.82.1 CreateAgentSessionRuntimeFactory seam', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent-dir');
    await mkdir(cwd, { recursive: true });
    const modelRuntime = await createModelRuntime(agentDir);
    const requests: string[] = [];
    const factory = createAgentCoreSessionRuntimeFactory(async (request) => {
      requests.push(request.cwd);
      return {
        applicationKind: 'tui',
        runtime: new TestAgentRuntime(request.cwd),
        host: createHost(),
        extensionPackages: [],
        importExtension: async () => {
          throw new Error('No extension package should be imported');
        },
        modelRuntime,
        settingsManager: SettingsManager.inMemory(),
      };
    });
    const sessionManager = SessionManager.inMemory(cwd);

    const runtime = await createAgentSessionRuntime(factory, {
      cwd,
      agentDir,
      sessionManager,
    });

    expect(requests).toEqual([cwd]);
    expect(runtime.cwd).toBe(cwd);
    expect(runtime.services.cwd).toBe(cwd);
    expect(runtime.services.agentDir).toBe(agentDir);
    expect(runtime.diagnostics).toEqual([]);
    expect(runtime.session.agent.state.isStreaming).toBe(false);

    await runtime.dispose();
  });

  it('keeps portable child request and result semantics on the host boundary', async () => {
    const host = createHost();
    const metadata = { lane: 'research', attempt: 2 } as const;
    const result = await host.createChildSession({
      rootSessionId: 'root',
      parentSessionId: 'parent',
      personaId: 'reviewer',
      prompt: 'Review the implementation',
      block: true,
      model: 'provider/model',
      timeoutMinutes: 15,
      metadata,
    });

    expect(result).toEqual({
      ok: true,
      sessionId: 'child-session',
      status: 'completed',
      result: 'done',
    });
  });
});

function createHost(wrapStreamFunction?: (original: StreamFunction) => StreamFunction): AgentSessionHost {
  return {
    ...(wrapStreamFunction === undefined ? {} : { wrapStreamFunction }),
    createChildSession: async () => ({
      ok: true,
      sessionId: 'child-session',
      status: 'completed',
      result: 'done',
    }),
  };
}

async function createModelRuntime(agentDir: string): Promise<ModelRuntime> {
  return ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: null,
  });
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'felan-session-'));
  temporaryPaths.push(path);
  return path;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
