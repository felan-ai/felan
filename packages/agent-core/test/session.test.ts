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
  createAssistantMessageEventStream,
  associateExtensionConfig,
  configField,
  createFelanServiceRegistry,
  createUnavailableExtensionUi,
  defineExtensionConfig,
  defineServiceContract,
  type ConfiguredFelanExtension,
  type FelanExtension,
  type ExtensionUi,
  type InlineExtension,
  type StreamFunction,
} from '../src/index.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAgentCoreSession,
  createAgentCoreSessionRuntime,
  createAgentCoreSessionRuntimeFactory,
  createRuntimeCodingTools,
  getProjectInstructions,
} from '../src/index.js';
import { TestAgentRuntime } from './test-agent-runtime.js';

const temporaryPaths: string[] = [];

afterEach(async () => {
  delete (globalThis as { ambientSessionExtension?: boolean }).ambientSessionExtension;
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe('Agent Core session composition', () => {
  it('propagates scoped UI through runtime options, configuration and reload', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent-dir');
    await mkdir(cwd, { recursive: true });
    const modelRuntime = await createModelRuntime(agentDir);
    const received: ExtensionUi[] = [];
    const notifications: Array<{ packageName: string; text: string }> = [];
    const createExtensionUi = vi.fn((packageName: string): ExtensionUi => ({
      ...createUnavailableExtensionUi(),
      notify: async message => { notifications.push({ packageName, text: message.text }); },
    }));
    const extension: FelanExtension = async pi => {
      received.push(pi.ui);
      await pi.ui.notify({ level: 'info', text: String(pi.config.message) });
    };
    associateExtensionConfig(extension, defineExtensionConfig({
      id: 'ui-example', title: 'UI example', fields: {
        message: configField.string({ default: 'default', description: 'Message' }),
      },
    }));
    const factory = createAgentCoreSessionRuntimeFactory(() => ({
      runtime: new TestAgentRuntime(cwd), modelRuntime, settingsManager: SettingsManager.inMemory(),
      extensionPackages: ['first', 'second'], importExtension: async () => ({ default: extension }),
      extensionConfigOverrides: [{ extensionId: 'ui-example', source: 'test', values: { message: 'configured' } }],
      createExtensionUi,
    }));
    const runtime = await createAgentSessionRuntime(factory, { cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) });
    try {
      expect(notifications).toEqual([
        { packageName: 'first', text: 'configured' }, { packageName: 'second', text: 'configured' },
      ]);
      await runtime.session.bindExtensions({ mode: 'print' });
      await runtime.session.reload();
      expect(createExtensionUi.mock.calls.map(([name]) => name)).toEqual(['first', 'second', 'first', 'second']);
      expect(notifications).toEqual([
        { packageName: 'first', text: 'configured' }, { packageName: 'second', text: 'configured' },
        { packageName: 'first', text: 'configured' }, { packageName: 'second', text: 'configured' },
      ]);
      expect(new Set(received).size).toBe(4);
    } finally {
      await runtime.dispose();
    }
  });

  it.each([false, true])('reports missing required services without secrets (caller callback: %s)', async (withCallback) => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent-dir');
    await mkdir(cwd, { recursive: true });
    const required = defineServiceContract<{}>('example.required', 2);
    const optional = defineServiceContract<{ token: string }>('example.optional', 1);
    const services = createFelanServiceRegistry();
    services.set(optional, { token: 'provider-secret-value' });
    const initialize = vi.fn();
    const execution = vi.fn(() => ({}));
    const missing: ConfiguredFelanExtension = Object.assign(initialize, {
      execution, serviceRequirements: { required: [required], optional: [optional] },
    });
    associateExtensionConfig(missing, defineExtensionConfig({
      id: 'missing', title: 'Missing service', fields: {
        token: configField.string({ default: '', sensitive: true, description: 'Token' }),
      },
    }));
    const available = vi.fn();
    const onServiceRequirementFailure = vi.fn();
    const result = await createAgentCoreSessionRuntime({
      runtime: new TestAgentRuntime(cwd), agentDir,
      modelRuntime: await createModelRuntime(agentDir),
      settingsManager: SettingsManager.inMemory(), sessionManager: SessionManager.inMemory(cwd),
      extensionPackages: ['@example/missing', '@example/available'],
      importExtension: async (name) => ({ default: name === '@example/missing' ? missing : available }),
      extensionConfigOverrides: [{ extensionId: 'missing', source: 'test', values: { token: 'config-secret-value' } }],
      services,
      ...(withCallback ? { onServiceRequirementFailure } : {}),
    });
    try {
      expect(initialize).not.toHaveBeenCalled();
      expect(execution).not.toHaveBeenCalled();
      expect(available).toHaveBeenCalledOnce();
      expect(result.extensionsResult.extensions.map(({ path }) => path)).not.toContain('<inline:@example/missing>');
      expect(result.diagnostics).toEqual([{
        type: 'warning',
        message: 'Disabled Felan extension @example/missing: required service example.required@2 has no configured provider.',
      }]);
      expect(result.services.diagnostics).toBe(result.diagnostics);
      expect(JSON.stringify(result.diagnostics)).not.toMatch(/provider-secret-value|config-secret-value/u);
      expect(onServiceRequirementFailure).toHaveBeenCalledTimes(withCallback ? 1 : 0);
      if (withCallback) expect(onServiceRequirementFailure).toHaveBeenCalledWith('@example/missing', 'example.required@2');
    } finally {
      result.session.dispose();
    }
  });

  it('composes package wrappers in load order before the external wrapper and never rewraps on reload', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent-dir');
    await mkdir(cwd, { recursive: true });
    const modelRuntime = await createModelRuntime(agentDir);
    const model = modelRuntime.getModel('openai-codex', 'gpt-5.6-sol')!;
    vi.spyOn(modelRuntime, 'hasConfiguredAuth').mockReturnValue(true);
    vi.spyOn(modelRuntime, 'getAuth').mockResolvedValue({ auth: { apiKey: 'test' } });
    const installed: string[] = [];
    const invoked: string[] = [];
    const resolveFirst = vi.fn(() => ({
      wrapStreamFunction: (_original: StreamFunction): StreamFunction => {
        installed.push('first');
        return (...args) => { invoked.push('first'); return completedStream(...args); };
      },
    }));
    const first: ConfiguredFelanExtension = Object.assign(() => {}, { execution: resolveFirst });
    const second: ConfiguredFelanExtension = Object.assign(() => {}, {
      execution: () => ({
        wrapStreamFunction: (original: StreamFunction): StreamFunction => {
          installed.push('second');
          return (...args) => { invoked.push('second'); return original(...args); };
        },
      }),
    });
    const result = await createAgentCoreSession({
      runtime: new TestAgentRuntime(cwd), agentDir, modelRuntime, model,
      extensionPackages: ['first', 'second'],
      importExtension: async (name) => ({ default: name === 'first' ? first : second }),
      settingsManager: SettingsManager.inMemory(), sessionManager: SessionManager.inMemory(cwd),
      wrapStreamFunction: (original) => {
        installed.push('external');
        return (...args) => { invoked.push('external'); return original(...args); };
      },
    });
    try {
      expect(installed).toEqual(['first', 'second', 'external']);
      expect(invoked).toEqual([]);
      await result.session.bindExtensions({ mode: 'print' });
      await result.session.prompt('First turn');
      expect(invoked).toEqual(['external', 'second', 'first']);
      const stream = result.session.agent.streamFunction;
      await result.session.reload();
      expect(result.session.agent.streamFunction).toBe(stream);
      expect(resolveFirst).toHaveBeenCalledOnce();
      expect(installed).toEqual(['first', 'second', 'external']);
      invoked.length = 0;
      await result.session.prompt('After reload');
      expect(invoked).toEqual(['external', 'second', 'first']);
    } finally {
      result.session.dispose();
    }
  });

  it.each(['enabled', 'disabled', 'missing-service', 'unsupported', 'name-only'] as const)(
    'uses declared native thinking support, not a package name: %s', async (mode) => {
      const root = await temporaryDirectory();
      const cwd = join(root, 'workspace');
      await mkdir(cwd, { recursive: true });
      const modelRuntime = await createModelRuntime(join(root, 'agent-dir'));
      const model = { ...modelRuntime.getModel('openai-codex', 'gpt-5.6-sol')!, id: 'gpt-6-astra' };
      vi.spyOn(modelRuntime, 'hasConfiguredAuth').mockReturnValue(true);
      vi.spyOn(modelRuntime, 'getAuth').mockResolvedValue({ auth: { apiKey: 'test' } });
      const classify = vi.fn(async () => ({
        answers: { 'thinking:effort': { type: 'choice' as const, choice: 'low' } },
      }));
      const supportsNativeThinkingUpdates = vi.fn(() => mode !== 'unsupported');
      const required = defineServiceContract<{}>('example.thinking', 1);
      const extension: ConfiguredFelanExtension = Object.assign(() => {}, {
        ...(mode === 'name-only' ? {} : { execution: () => ({ supportsNativeThinkingUpdates }) }),
        ...(mode === 'missing-service' ? { serviceRequirements: { required: [required] } } : {}),
      });
      const result = await createAgentCoreSession({
        runtime: Object.assign(new TestAgentRuntime(cwd), { classifier: { classify } }),
        modelRuntime, model, thinkingLevel: 'high', dynamicThinking: true,
        extensionPackages: mode === 'disabled' ? [] : [mode === 'name-only' ? '@felan-ai/ext-codex' : 'example'],
        importExtension: async () => ({ default: extension }),
        settingsManager: SettingsManager.inMemory(), sessionManager: SessionManager.inMemory(cwd),
        services: createFelanServiceRegistry(),
        wrapStreamFunction: () => completedStream,
      });
      try {
        await result.session.bindExtensions({ mode: 'print' });
        await result.session.prompt('Summarize the file');
        expect(classify).toHaveBeenCalledTimes(mode === 'enabled' ? 1 : 0);
        expect(result.session.thinkingLevel).toBe(mode === 'enabled' ? 'low' : 'high');
        if (mode === 'enabled') {
          expect(supportsNativeThinkingUpdates).toHaveBeenCalledWith(expect.objectContaining({ id: model.id }));
          result.session.setThinkingLevel('high');
          await result.session.prompt('Manual selection remains authoritative');
          expect(classify).toHaveBeenCalledOnce();
          expect(result.session.thinkingLevel).toBe('high');
        }
      } finally {
        result.session.dispose();
      }
    },
  );

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
      '<inline:@felan-ai/agent-core/selection-automation>',
      '<inline:@felan-ai/agent-core/project-instructions>',
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
    for (const nativeTool of ['codemode', 'tool_search', 'mcp']) {
      expect(result.session.agent.state.tools.map((tool) => tool.name)).not.toContain(nativeTool);
    }

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
    expect(systemPrompt).not.toContain('<project_context>');
    expect(systemPrompt).not.toContain('Root project instructions');

    result.session.dispose();
  });

  it('loads explicitly supplied native Pi extensions while keeping ambient discovery disabled', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent-dir');
    const explicit = join(root, 'explicit-extension.mjs');
    await mkdir(cwd, { recursive: true });
    await writeFile(explicit,
      'export default (pi) => pi.registerCommand("explicit", { description: "explicit", handler: async () => {} });');

    const result = await createAgentCoreSession({
      runtime: new TestAgentRuntime(cwd),
      extensionPackages: [],
      extensionPaths: [explicit],
      importExtension: async () => {
        throw new Error('No Felan extension package should be imported');
      },
      modelRuntime: await createModelRuntime(agentDir),
      settingsManager: SettingsManager.inMemory({ extensions: [explicit] }),
      sessionManager: SessionManager.inMemory(cwd),
      agentDir,
    });

    expect(result.extensionsResult.extensions.map((extension) => extension.path)).toEqual([
      explicit,
      '<inline:@felan-ai/agent-core/selection-automation>',
      '<inline:@felan-ai/agent-core/runtime-tools>',
    ]);
    expect(result.extensionsResult.extensions[0]?.commands.has('explicit')).toBe(true);
    expect(result.session.resourceLoader.getExtensions().extensions.map((extension) => extension.path)).toEqual([
      explicit,
      '<inline:@felan-ai/agent-core/selection-automation>',
      '<inline:@felan-ai/agent-core/runtime-tools>',
    ]);
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
    expect(claudeResult.session.systemPrompt).not.toContain('Claude fallback instructions');
    claudeResult.session.dispose();

    await runtime.writeFile('AGENTS.md', new TextEncoder().encode('Agent instructions'));
    const agentResult = await compose();
    expect(agentResult.session.systemPrompt).not.toContain('Agent instructions');
    expect(agentResult.session.systemPrompt).not.toContain('Claude fallback instructions');
    agentResult.session.dispose();
  });

  it('delivers cwd instructions once as hidden user context, not in the system prompt', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent-dir');
    await mkdir(cwd, { recursive: true });
    const runtime = new TestAgentRuntime(cwd);
    await runtime.writeFile('AGENTS.md', new TextEncoder().encode('Keep Pi package names unchanged.'));
    const result = await createAgentCoreSession({
      runtime,
      extensionPackages: [],
      importExtension: async () => ({}),
      modelRuntime: await createModelRuntime(agentDir),
      settingsManager: SettingsManager.inMemory(),
      sessionManager: SessionManager.inMemory(cwd),
      agentDir,
    });

    expect(result.session.systemPrompt).not.toContain('Keep Pi package names unchanged.');
    expect(result.session.resourceLoader.getAgentsFiles().agentsFiles).toEqual([]);
    expect(getProjectInstructions(result.session.resourceLoader)).toEqual({
      path: join(cwd, 'AGENTS.md'),
      content: 'Keep Pi package names unchanged.',
    });

    const transformContext = result.session.agent.transformContext;
    if (!transformContext) throw new Error('Expected Pi to install its context transform');
    const initial = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Inspect' }], timestamp: 1 }];
    const transformed = await transformContext(initial);
    const messages = await result.session.agent.convertToLlm(transformed);
    const projectInstructions = messages.find(({ role, content }) => (
      role === 'user'
      && Array.isArray(content)
      && content.some((part) => part.type === 'text' && part.text.includes('Keep Pi package names unchanged.'))
    ));

    expect(messages[0]?.role).toBe('user');
    expect(projectInstructions).toBeDefined();
    expect(JSON.stringify(projectInstructions)).toContain(join(cwd, 'AGENTS.md').replace(/\\/g, '/'));

    const replayed = await transformContext(transformed);
    const replayedMessages = await result.session.agent.convertToLlm(replayed);
    expect(replayedMessages.filter(({ role, content }) => (
      role === 'user'
      && Array.isArray(content)
      && content.some((part) => part.type === 'text' && part.text.includes('Keep Pi package names unchanged.'))
    ))).toHaveLength(1);
    result.session.dispose();
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

  it('provides a Pi CreateAgentSessionRuntimeFactory seam', async () => {
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

  it('composes dynamic thinking only when enabled and a classifier is available', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    await mkdir(cwd, { recursive: true });
    const modelRuntime = await createModelRuntime(join(root, 'agent-dir'));
    const classifier = { classify: vi.fn() };
    const createReporter = vi.fn().mockReturnValue({ report: vi.fn() });
    for (const [enabled, available, expected] of [
      [true, true, true], [false, true, false], [true, false, false],
    ] as const) {
      const runtime = Object.assign(new TestAgentRuntime(cwd), available ? { classifier } : {});
      const result = await createAgentCoreSession({
        runtime, ...(enabled ? { dynamicThinking: true } : {}),
        savings: { createReporter },
        extensionPackages: [], importExtension: async () => ({}),
        modelRuntime, settingsManager: SettingsManager.inMemory(), sessionManager: SessionManager.inMemory(cwd),
      });
      expect(result.extensionsResult.extensions.some((extension) => (
        extension.path === '<inline:@felan-ai/agent-core/dynamic-thinking>'
      ))).toBe(expected);
      expect(createReporter).toHaveBeenCalledTimes(expected ? 1 : 0);
      if (expected) expect(createReporter).toHaveBeenCalledWith('@felan-ai/agent-core/dynamic-thinking');
      createReporter.mockClear();
      result.session.dispose();
    }
    expect(classifier.classify).not.toHaveBeenCalled();

    const result = await createAgentCoreSession({
      runtime: Object.assign(new TestAgentRuntime(cwd), { classifier }),
      dynamicThinking: true,
      savings: { createReporter: () => { throw new Error('Savings reporter unavailable'); } },
      extensionPackages: [], importExtension: async () => ({}),
      modelRuntime, settingsManager: SettingsManager.inMemory(), sessionManager: SessionManager.inMemory(cwd),
    });
    expect(result.extensionsResult.extensions.some((extension) => (
      extension.path === '<inline:@felan-ai/agent-core/dynamic-thinking>'
    ))).toBe(true);
    result.session.dispose();
  });

  it('binds a session-owned classification registry only to roots with a classifier', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    await mkdir(cwd, { recursive: true });
    const modelRuntime = await createModelRuntime(join(root, 'agent-dir'));
    const classifier = { classify: vi.fn() };
    const registries: unknown[] = [];
    for (const child of [false, false, true]) {
      const manager = SessionManager.inMemory(cwd);
      if (child) {
        const header = manager.getHeader()!;
        vi.spyOn(manager, 'getHeader').mockReturnValue({ ...header, parentSession: 'parent' });
      }
      const result = await createAgentCoreSession({
        runtime: Object.assign(new TestAgentRuntime(cwd), { classifier }),
        extensionPackages: ['@felan-ai/test-contribution'],
        importExtension: async () => ({ default: ((pi) => {
          registries.push(pi.turnClassification);
          pi.turnClassification?.register({ id: 'test', prepare: () => ({ questions: {
            needed: { type: 'bool', instructions: 'Is work needed?', criteria: { true: 'yes', false: 'no' } },
          } }) });
        }) satisfies FelanExtension }),
        modelRuntime, settingsManager: SettingsManager.inMemory(), sessionManager: manager,
      });
      result.session.dispose();
    }
    expect(registries[0]).toBeDefined();
    expect(registries[1]).toBeDefined();
    expect(registries[0]).not.toBe(registries[1]);
    expect(registries[2]).toBeUndefined();
    expect(classifier.classify).not.toHaveBeenCalled();
  });

  it.each(['external', 'contribution'] as const)('disposes partial Pi sessions when the %s stream wrapper throws', async (source) => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent-dir');
    await mkdir(cwd, { recursive: true });
    const modelRuntime = await createModelRuntime(agentDir);
    const dispose = vi.spyOn(AgentSession.prototype, 'dispose');
    const wrappingSession = SessionManager.inMemory(cwd);

    const wrapStreamFunction = () => { throw new Error('stream wrapper failed'); };
    await expect(createAgentCoreSession({
      runtime: new TestAgentRuntime(cwd),
      ...(source === 'external' ? { wrapStreamFunction } : {}),
      extensionPackages: source === 'contribution' ? ['example'] : [],
      importExtension: async () => ({ default: Object.assign(() => {}, {
        execution: () => ({ wrapStreamFunction }),
      }) }),
      modelRuntime,
      settingsManager: SettingsManager.inMemory(),
      sessionManager: wrappingSession,
    })).rejects.toThrow('stream wrapper failed');

    expect(dispose).toHaveBeenCalledOnce();
    dispose.mockRestore();
  });
});

const completedStream: StreamFunction = (model) => {
  const stream = createAssistantMessageEventStream();
  stream.push({
    type: 'done', reason: 'stop', message: {
      role: 'assistant', content: [{ type: 'text', text: 'Done' }],
      api: model.api, provider: model.provider, model: model.id,
      usage: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop', timestamp: Date.now(),
    },
  });
  return stream;
};

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
