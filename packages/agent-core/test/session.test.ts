import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ModelRuntime,
  AgentSession,
  FELAN_BASE_SYSTEM_PROMPT,
  SessionManager,
  SettingsManager,
  createAgentSessionRuntime,
  type FelanExtension,
  type InlineExtension,
  type StreamFunction,
} from '../src/index.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAgentCoreSession,
  createAgentCoreSessionRuntimeFactory,
  createRuntimeCodingTools,
} from '../src/index.js';
import { TestAgentRuntime } from './test-agent-runtime.js';

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
    await runtime.writeFile('AGENTS.md', new TextEncoder().encode('Root project instructions'));
    const order: string[] = [];
    let wrappedInvocations = 0;
    let streamWrapped = false;
    const extension: FelanExtension = (pi) => {
      expect(pi.agentDir).toBe(agentDir);
      pi.registerCapability({ id: 'test-capability', instructions: 'Capability instructions' });
      order.push('extension factory');
      pi.on('session_start', () => {
        expect(streamWrapped).toBe(true);
        order.push('session start');
      });
    };
    const wrapStreamFunction = (original: StreamFunction) => {
      order.push('stream wrapped');
      streamWrapped = true;
      return ((model, context, options) => {
        wrappedInvocations += 1;
        return original(model, context, options);
      }) satisfies StreamFunction;
    };
    const inlineExtension: InlineExtension = {
      name: '@felan-ai/test-inline',
      hidden: true,
      factory: () => {
        order.push('inline extension factory');
      },
    };
    const appTool = { ...createRuntimeCodingTools(runtime)[0]!, name: 'app-tool', label: 'app-tool' };

    const result = await createAgentCoreSession({
      runtime,
      wrapStreamFunction,
      extensionPackages: ['@felan-ai/listed'],
      importExtension: async (packageName) => {
        order.push(`import ${packageName}`);
        return { default: extension };
      },
      modelRuntime,
      settingsManager: appSettings,
      sessionManager,
      agentDir,
      inlineExtensions: [inlineExtension],
      customTools: [appTool],
      appendSystemPrompt: ['Child persona instructions'],
    });

    expect(order).toEqual([
      'import @felan-ai/listed',
      'extension factory',
      'inline extension factory',
      'stream wrapped',
    ]);
    expect(result.session.settingsManager).toBe(appSettings);
    expect(result.session.sessionManager).toBe(sessionManager);
    expect(result.session.modelRuntime).toBe(modelRuntime);
    expect(result.session.agent.state.isStreaming).toBe(false);
    expect(result.session.agent.state.messages).toEqual([]);
    expect(result.session.resourceLoader.getExtensions().extensions)
      .toContainEqual(expect.objectContaining({ path: '<inline:@felan-ai/test-inline>', hidden: true }));
    expect(wrappedInvocations).toBe(0);
    expect(result.extensionsResult.extensions.map((loaded) => loaded.path)).toEqual([
      '<inline:@felan-ai/listed>',
      '<inline:@felan-ai/test-inline>',
      '<inline:@felan-ai/agent-core/runtime-tools>',
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

    await result.session.bindExtensions({ mode: 'print' });
    expect(order).toEqual([
      'import @felan-ai/listed',
      'extension factory',
      'inline extension factory',
      'stream wrapped',
      'session start',
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
    const systemPrompt = result.session.systemPrompt;
    expect(systemPrompt.startsWith(FELAN_BASE_SYSTEM_PROMPT)).toBe(true);
    expect(systemPrompt).not.toContain('operating inside pi');
    expect(systemPrompt.indexOf('## Enabled capabilities')).toBeGreaterThan(-1);
    expect(systemPrompt.indexOf('Capability instructions')).toBeLessThan(
      systemPrompt.indexOf('Child persona instructions'),
    );
    expect(systemPrompt.indexOf('Child persona instructions')).toBeLessThan(
      systemPrompt.indexOf('Project-specific instructions and guidelines:'),
    );
    expect(systemPrompt).toContain('<project_context>');
    expect(systemPrompt).toContain(
      `<project_instructions path="${join(cwd, 'AGENTS.md').replace(/\\/g, '/')}">`,
    );
    expect(systemPrompt.indexOf('Root project instructions')).toBeLessThan(
      systemPrompt.indexOf('Current working directory:'),
    );

    result.session.dispose();
  });

  it('carries the active thinking level across a session-only model switch', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent-dir');
    await mkdir(cwd, { recursive: true });
    const modelRuntime = await createModelRuntime(agentDir);
    const planner = modelRuntime.getModel('openai-codex', 'gpt-5.6-sol');
    const target = modelRuntime.getModel('openai-codex', 'gpt-5.6-luna');
    if (!planner || !target) throw new Error('Expected built-in OpenAI Codex models');
    vi.spyOn(modelRuntime, 'hasConfiguredAuth').mockReturnValue(true);
    vi.spyOn(modelRuntime, 'checkAuth').mockResolvedValue({} as never);
    const settingsManager = SettingsManager.inMemory({ defaultThinkingLevel: 'max' });
    let extensionApi: Parameters<FelanExtension>[0] | undefined;

    const result = await createAgentCoreSession({
      runtime: new TestAgentRuntime(cwd),
      extensionPackages: ['@felan-ai/test-selection'],
      importExtension: async () => ({
        default: ((pi) => { extensionApi = pi; }) satisfies FelanExtension,
      }),
      modelRuntime,
      settingsManager,
      sessionManager: SessionManager.inMemory(cwd),
      model: planner,
      thinkingLevel: 'xhigh',
    });
    await result.session.bindExtensions({ mode: 'print' });

    await extensionApi!.setModel(target, { updateDefault: false });

    expect(result.session.model).toBe(target);
    expect(result.session.thinkingLevel).toBe('xhigh');
    expect(settingsManager.getDefaultThinkingLevel()).toBe('max');
    result.session.dispose();
  });

  it('loads cwd CLAUDE.md as fallback and prefers AGENTS.md', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent-dir');
    await mkdir(cwd, { recursive: true });
    const runtime = new TestAgentRuntime(cwd);
    const modelRuntime = await createModelRuntime(agentDir);
    const compose = () => createAgentCoreSession({
      runtime,
      extensionPackages: [],
      importExtension: async () => {
        throw new Error('No extension package should be imported');
      },
      modelRuntime,
      settingsManager: SettingsManager.inMemory(),
      sessionManager: SessionManager.inMemory(cwd),
      agentDir,
    });
    await runtime.writeFile(
      'CLAUDE.md',
      new TextEncoder().encode('\nClaude fallback instructions\n'),
    );

    const claudeResult = await compose();
    expect(claudeResult.session.systemPrompt).toContain(
      `<project_instructions path="${join(cwd, 'CLAUDE.md').replace(/\\/g, '/')}">\n`
      + '\nClaude fallback instructions\n',
    );
    claudeResult.session.dispose();

    await runtime.writeFile('AGENTS.md', new TextEncoder().encode('Agent instructions'));
    const agentResult = await compose();
    expect(agentResult.session.systemPrompt).toContain(
      `<project_instructions path="${join(cwd, 'AGENTS.md').replace(/\\/g, '/')}">\n`
      + 'Agent instructions',
    );
    expect(agentResult.session.systemPrompt).not.toContain('Claude fallback instructions');
    agentResult.session.dispose();
  });

  it('lets feature extensions override runtime-backed coding tools', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent-dir');
    await mkdir(cwd, { recursive: true });
    const runtime = new TestAgentRuntime(cwd);
    const runtimeBash = createRuntimeCodingTools(runtime).find((tool) => tool.name === 'bash')!;
    const execute = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'feature bash executed' }],
      details: undefined,
    }));
    const extension: FelanExtension = (pi) => {
      pi.registerTool({
        ...runtimeBash,
        description: 'Feature-owned bash override before activation',
        execute,
      });
      pi.on('session_start', () => {
        pi.registerTool({
          ...runtimeBash,
          description: 'Feature-owned bash override',
          execute,
        });
      });
    };
    const result = await createAgentCoreSession({
      runtime,
      extensionPackages: ['@felan-ai/bash-feature'],
      importExtension: async () => ({ default: extension }),
      modelRuntime: await createModelRuntime(agentDir),
      settingsManager: SettingsManager.inMemory(),
      sessionManager: SessionManager.inMemory(cwd),
      agentDir,
    });

    expect(result.session.agent.state.tools.find((tool) => tool.name === 'bash')?.description)
      .toBe('Feature-owned bash override before activation');
    await result.session.bindExtensions({ mode: 'print' });
    const bash = result.session.agent.state.tools.find((tool) => tool.name === 'bash')!;
    expect(bash.description).toBe('Feature-owned bash override');
    await expect(bash.execute('call', { command: 'echo ignored' })).resolves.toMatchObject({
      content: [{ type: 'text', text: 'feature bash executed' }],
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(runtime.shellCalls).toEqual([]);

    result.session.dispose();
  });

  it('provides a Pi 0.85.0 CreateAgentSessionRuntimeFactory seam', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent-dir');
    await mkdir(cwd, { recursive: true });
    const modelRuntime = await createModelRuntime(agentDir);
    const requests: string[] = [];
    const factory = createAgentCoreSessionRuntimeFactory(async (request) => {
      requests.push(request.cwd);
      return {
        runtime: new TestAgentRuntime(request.cwd),
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

  it('wraps streaming before returning the session', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent-dir');
    await mkdir(cwd, { recursive: true });
    const sessionManager = SessionManager.inMemory(cwd);
    const order: string[] = [];

    const result = await createAgentCoreSession({
      runtime: new TestAgentRuntime(cwd),
      wrapStreamFunction: (stream) => {
        order.push('stream wrapped');
        return stream;
      },
      extensionPackages: [],
      importExtension: async () => ({}),
      modelRuntime: await createModelRuntime(agentDir),
      settingsManager: SettingsManager.inMemory(),
      sessionManager,
    });

    expect(order).toEqual(['stream wrapped']);
    result.session.dispose();
  });

  it('disposes partial Pi sessions when the stream wrapper throws', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent-dir');
    await mkdir(cwd, { recursive: true });
    const modelRuntime = await createModelRuntime(agentDir);
    const dispose = vi.spyOn(AgentSession.prototype, 'dispose');
    const wrappingSession = SessionManager.inMemory(cwd);

    await expect(createAgentCoreSession({
      runtime: new TestAgentRuntime(cwd),
      wrapStreamFunction: () => {
        throw new Error('stream wrapper failed');
      },
      extensionPackages: [],
      importExtension: async () => ({}),
      modelRuntime,
      settingsManager: SettingsManager.inMemory(),
      sessionManager: wrappingSession,
    })).rejects.toThrow('stream wrapper failed');

    expect(dispose).toHaveBeenCalledOnce();
    dispose.mockRestore();
  });
});

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
