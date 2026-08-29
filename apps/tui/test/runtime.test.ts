import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FELAN_BASE_SYSTEM_PROMPT,
  AGENT_CORE_VERSION,
  HostAgentRuntime,
  SessionManager,
  associateExtensionConfig,
  configField,
  createAgentSessionRuntime,
  defineExtensionConfig,
  getSupportedThinkingLevels,
  type FelanExtensionAPI,
} from '@felan-ai/agent-core';
import { InteractiveMode } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';

const modelScope = vi.hoisted(() => ({ resolutions: 0 }));

vi.mock('@earendil-works/pi-coding-agent', async (importOriginal) => {
  const original = await importOriginal<typeof import('@earendil-works/pi-coding-agent')>();
  return {
    ...original,
    resolveModelScopeWithDiagnostics: async (...args: Parameters<typeof original.resolveModelScopeWithDiagnostics>) => {
      modelScope.resolutions += 1;
      return original.resolveModelScopeWithDiagnostics(...args);
    },
  };
});

import {
  createLocalFelanRuntime,
  createLocalModelRuntime,
  createLocalSessionRuntimeFactory,
  getLocalSkillPaths,
} from '../src/runtime.js';
import type { LocalAgentRuntimeFactoryRequest } from '../src/runtime-factory.js';
import { SAVINGS_COMMAND_EXTENSION_NAME } from '../src/savings-command.js';
import { createToolActivityRuntimeView } from '../src/tool-activity/runtime-view.js';

const temporaryPaths: string[] = [];

afterEach(async () => {
  modelScope.resolutions = 0;
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe('local Agent Core lifecycle', () => {
  it('guards concurrent Pi credential writes with the local async lock', async () => {
    const root = await temporaryDirectory();
    const agentDir = join(root, 'agent');
    await mkdir(agentDir, { recursive: true });
    const modelRuntime = await createLocalModelRuntime(agentDir);

    await Promise.all([
      modelRuntime.login('anthropic', 'api_key', {
        prompt: async () => 'anthropic-test-key',
        notify: () => {},
      }),
      modelRuntime.login('openai', 'api_key', {
        prompt: async () => 'openai-test-key',
        notify: () => {},
      }),
    ]);

    const stored = JSON.parse(await readFile(join(agentDir, 'auth.json'), 'utf8')) as Record<string, unknown>;
    expect(stored).toMatchObject({
      anthropic: { type: 'api_key', key: 'anthropic-test-key' },
      openai: { type: 'api_key', key: 'openai-test-key' },
    });
  });

  it('uses the Felan root for sessions and loads only configured built-ins, root instructions, and .agents skills', async () => {
    const root = await temporaryDirectory();
    const home = join(root, 'home');
    const cwd = join(root, 'workspace');
    const agentDir = join(home, '.felan');
    const projectSkills = join(cwd, '.agents', 'skills');
    const userSkills = join(home, '.agents', 'skills');
    const ignoredSkills = join(agentDir, 'skills');
    await Promise.all([
      mkdir(join(cwd, '.pi'), { recursive: true }),
      mkdir(join(projectSkills, 'project-skill'), { recursive: true }),
      mkdir(join(userSkills, 'user-skill'), { recursive: true }),
      mkdir(join(ignoredSkills, 'ignored-skill'), { recursive: true }),
      mkdir(agentDir, { recursive: true }),
    ]);
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({
      builtinExtensions: {
        subagents: false,
        askUser: false,
        tasks: false,
        prewalk: false,
        context: false,
        contextView: false,
        markitdown: false,
        mcp: false,
        webAccess: false,
        browser: false,
        backgroundBash: false,
        codex: false,
        rtkOptimizer: false,
        memory: false,
        felanApi: false,
        powerline: false,
        outputStyle: false,
        promptHistory: false,
        insights: false,
      },
    }));
    await writeFile(join(agentDir, 'APPEND_SYSTEM.md'), 'Local application instructions');
    await writeFile(join(cwd, '.pi', 'APPEND_SYSTEM.md'), 'Ignored project append');
    await writeFile(join(cwd, 'AGENTS.md'), 'Root project instructions');
    await writeFile(join(cwd, 'CLAUDE.md'), 'Ignored fallback instructions');
    await writeFile(join(projectSkills, 'project-skill', 'SKILL.md'), skill('project-skill'));
    await writeFile(join(userSkills, 'user-skill', 'SKILL.md'), skill('user-skill'));
    await writeFile(join(ignoredSkills, 'ignored-skill', 'SKILL.md'), skill('ignored-skill'));
    const skillPaths = getLocalSkillPaths(cwd, home);

    expect(skillPaths).toEqual([projectSkills, userSkills]);

    const runtime = await createLocalFelanRuntime({ cwd, agentDir, homeDir: home, skillPaths });

    expect(runtime.session.sessionManager.getSessionDir()).toBe(join(agentDir, 'sessions'));
    const loadedExtensions = runtime.services.resourceLoader.getExtensions().extensions;
    expect(loadedExtensions.filter((extension) => !extension.hidden)).toEqual([]);
    expect(loadedExtensions).toContainEqual(expect.objectContaining({
      path: `<inline:${SAVINGS_COMMAND_EXTENSION_NAME}>`,
      hidden: true,
    }));
    expect(runtime.services.resourceLoader.getSkills().skills.map(({ name }) => name)).toEqual([
      'project-skill',
      'user-skill',
    ]);
    expect(runtime.session.agent.state.tools.map(({ name }) => name)).not.toContain('Agent');
    const systemPrompt = runtime.session.systemPrompt;
    expect(systemPrompt.startsWith(FELAN_BASE_SYSTEM_PROMPT)).toBe(true);
    expect(systemPrompt).not.toContain('Be concise and direct');
    expect(systemPrompt).toContain('Local application instructions');
    expect(systemPrompt).toContain('Root project instructions');
    expect(systemPrompt).not.toContain('Ignored fallback instructions');
    expect(systemPrompt).not.toContain('Ignored project append');
    expect(systemPrompt).not.toContain('## Enabled capabilities');
    expect(systemPrompt.indexOf('Local application instructions')).toBeLessThan(
      systemPrompt.indexOf('Root project instructions'),
    );
    expect(systemPrompt.indexOf('Root project instructions')).toBeLessThan(
      systemPrompt.indexOf('<available_skills>'),
    );
    expect(systemPrompt.indexOf('<available_skills>')).toBeLessThan(
      systemPrompt.indexOf('Current working directory:'),
    );

    await runtime.dispose();
  });

  it('resolves configured model scope once per session', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent');
    await Promise.all([cwd, agentDir].map((path) => mkdir(path, { recursive: true })));
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({
      enabledModels: ['missing-model'],
    }));

    const runtime = await createAgentSessionRuntime(createLocalSessionRuntimeFactory({
      agentDir,
      homeDir: root,
      modelRuntime: await createLocalModelRuntime(agentDir),
      extensionPackages: [],
      importExtension: async () => {
        throw new Error('No extensions should be imported');
      },
    }), {
      cwd,
      agentDir,
      sessionManager: SessionManager.inMemory(cwd),
    });

    expect(modelScope.resolutions).toBe(1);

    await runtime.dispose();
  });

  it('warns and starts with defaults when persisted extension configuration is invalid', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent');
    await Promise.all([cwd, agentDir].map((path) => mkdir(path, { recursive: true })));
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({
      extensionConfig: {
        prewalk: {
          entryApproval: 'always',
          restorePlanner: false,
        },
      },
    }));
    const definition = defineExtensionConfig({
      id: 'prewalk',
      title: 'Prewalk',
      fields: {
        entryApproval: configField.enum(['ask', 'allow', 'deny'], {
          default: 'ask',
          description: 'Approval policy for model-entered Prewalk',
        }),
        restorePlanner: configField.boolean({
          default: true,
          description: 'Restore the planner after implementation',
        }),
      },
    });
    let receivedConfig: FelanExtensionAPI['config'] | undefined;
    const extension = (pi: FelanExtensionAPI) => {
      receivedConfig = pi.config;
    };
    associateExtensionConfig(extension, definition);
    const packageName = '@felan-ai/test-invalid-config';
    const runtime = await createAgentSessionRuntime(createLocalSessionRuntimeFactory({
      agentDir,
      homeDir: root,
      modelRuntime: await createLocalModelRuntime(agentDir),
      extensionPackages: [packageName],
      importExtension: async (requestedPackage) => {
        expect(requestedPackage).toBe(packageName);
        return { default: extension };
      },
    }), {
      cwd,
      agentDir,
      sessionManager: SessionManager.inMemory(cwd),
    });

    expect(receivedConfig).toEqual({ entryApproval: 'ask', restorePlanner: false });
    expect(runtime.diagnostics).toContainEqual({
      type: 'warning',
      message: 'settings.json.extensionConfig.prewalk.entryApproval must be one of: ask, allow, deny; using the default value.',
    });
    expect(JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8')))
      .toMatchObject({ extensionConfig: { prewalk: { entryApproval: 'always' } } });

    await runtime.dispose();
  });

  it('applies explicit model and thinking selection when resuming a session', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent');
    await Promise.all([cwd, agentDir].map((path) => mkdir(path, { recursive: true })));
    const modelRuntime = await createLocalModelRuntime(agentDir);
    const model = modelRuntime.getModels().find((candidate) => (
      getSupportedThinkingLevels(candidate).includes('high')
    ));
    expect(model).toBeDefined();
    const sessionManager = SessionManager.inMemory(cwd);
    sessionManager.appendMessage({ role: 'user', content: 'previous prompt', timestamp: Date.now() });
    sessionManager.appendMessage(completedAssistantMessage('previous response'));

    const runtime = await createLocalFelanRuntime({
      cwd,
      agentDir,
      homeDir: root,
      modelRuntime,
      sessionManager,
      model: model!,
      thinkingLevel: 'high',
    });

    expect(runtime.session.model).toBe(model);
    expect(runtime.session.thinkingLevel).toBe('high');
    await runtime.dispose();
  });

  it('reloads the local tool display mode before rebuilding presentation definitions', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent');
    await Promise.all([cwd, agentDir].map((path) => mkdir(path, { recursive: true })));
    const runtime = await createLocalFelanRuntime({ cwd, agentDir, homeDir: root });
    const runtimeView = createToolActivityRuntimeView(runtime);

    expect(runtimeView.session.getToolDefinition('read')).not.toBe(runtime.session.getToolDefinition('read'));

    await runtime.session.bindExtensions({ mode: 'print' });
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({
      felanTui: { toolDisplay: 'full' },
    }));
    await runtime.session.reload();

    expect(runtimeView.session.getToolDefinition('read')).toBe(runtime.session.getToolDefinition('read'));
    await runtime.dispose();
  });

  it('awaits the local subagent host before Pi runtime disposal', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent');
    await Promise.all([cwd, agentDir].map((path) => mkdir(path, { recursive: true })));
    const runtime = await createLocalFelanRuntime({ cwd, agentDir, homeDir: root });
    const host = runtime.localSubagentHost;
    const order: string[] = [];
    const shutdown = host.shutdown.bind(host);
    host.shutdown = async () => {
      order.push('host');
      await shutdown();
    };
    const disposeSession = runtime.session.dispose.bind(runtime.session);
    runtime.session.dispose = () => {
      order.push('pi');
      disposeSession();
    };

    await runtime.dispose();

    expect(order).toEqual(['host', 'pi']);
  });

  it('disposes Pi when local subagent shutdown fails', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent');
    await Promise.all([cwd, agentDir].map((path) => mkdir(path, { recursive: true })));
    const runtime = await createLocalFelanRuntime({ cwd, agentDir, homeDir: root });
    const host = runtime.localSubagentHost;
    host.shutdown = async () => {
      throw new Error('shutdown failed');
    };
    const disposeSession = runtime.session.dispose.bind(runtime.session);
    const observedDispose = vi.fn(() => disposeSession());
    runtime.session.dispose = observedDispose;

    await expect(runtime.dispose()).rejects.toThrow('shutdown failed');

    expect(observedDispose).toHaveBeenCalledOnce();
  });

  it('keeps the active host when session replacement is cancelled', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent');
    const sessionDir = join(root, 'sessions');
    await Promise.all([cwd, agentDir, sessionDir].map((path) => mkdir(path, { recursive: true })));
    const sessionManager = SessionManager.create(cwd, sessionDir);
    const entryId = sessionManager.appendMessage({
      role: 'user', content: 'initial prompt', timestamp: Date.now(),
    });
    sessionManager.appendMessage(completedAssistantMessage('initial response'));
    const runtime = await createLocalFelanRuntime({
      cwd,
      agentDir,
      homeDir: root,
      sessionDir,
      sessionManager,
    });
    const host = runtime.localSubagentHost;
    const shutdown = vi.spyOn(host, 'shutdown');
    const runner = runtime.session.extensionRunner as unknown as {
      hasHandlers(event: string): boolean;
      emit(event: { type: string }): Promise<{ cancel?: boolean } | undefined>;
    };
    const hasHandlers = runner.hasHandlers.bind(runner);
    const emit = runner.emit.bind(runner);
    const beforeEvents: string[] = [];
    const hasHandlersSpy = vi.spyOn(runner, 'hasHandlers').mockImplementation((event) => (
      event === 'session_before_switch' || event === 'session_before_fork' || hasHandlers(event)
    ));
    const emitSpy = vi.spyOn(runner, 'emit').mockImplementation(async (event) => {
      if (event.type === 'session_before_switch' || event.type === 'session_before_fork') {
        beforeEvents.push(event.type);
        return { cancel: true };
      }
      return emit(event);
    });

    await expect(runtime.newSession()).resolves.toEqual({ cancelled: true });
    await expect(runtime.fork(entryId, { position: 'at' })).resolves.toEqual({ cancelled: true });

    expect(beforeEvents).toEqual(['session_before_switch', 'session_before_fork']);
    expect(runtime.localSubagentHost).toBe(host);
    expect(shutdown).not.toHaveBeenCalled();

    emitSpy.mockRestore();
    hasHandlersSpy.mockRestore();
    await runtime.dispose();
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it('recreates host runtime and services for fork, new, resume, and import', async () => {
    const root = await temporaryDirectory();
    const cwdA = join(root, 'workspace-a');
    const cwdB = join(root, 'workspace-b');
    const cwdC = join(root, 'workspace-c');
    const agentDir = join(root, 'agent');
    const sessionDir = join(root, 'sessions');
    const importDir = join(root, 'imports');
    await Promise.all([cwdA, cwdB, cwdC, agentDir, sessionDir, importDir].map(
      (path) => mkdir(path, { recursive: true }),
    ));

    const createdHostRuntimes: HostAgentRuntime[] = [];
    const runtimeRequests: LocalAgentRuntimeFactoryRequest[] = [];
    const modelRuntime = await createLocalModelRuntime(agentDir);
    const createRuntime = createLocalSessionRuntimeFactory({
      agentDir,
      homeDir: root,
      modelRuntime,
      extensionPackages: [],
      importExtension: async () => {
        throw new Error('No extensions should be imported');
      },
      runtimeFactory: (request) => {
        runtimeRequests.push(request);
        const hostRuntime = new HostAgentRuntime(request.cwd, request);
        createdHostRuntimes.push(hostRuntime);
        return hostRuntime;
      },
    });
    const initialSessionManager = SessionManager.create(cwdA, sessionDir);
    const entryId = initialSessionManager.appendMessage({
      role: 'user',
      content: 'initial prompt',
      timestamp: Date.now(),
    });
    initialSessionManager.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'initial response' }],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'test-model',
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: Date.now(),
    });
    const runtime = await createAgentSessionRuntime(createRuntime, {
      cwd: cwdA,
      agentDir,
      sessionManager: initialSessionManager,
    });
    const activeSessionIds = [runtime.session.sessionManager.getSessionId()];
    const reboundCwds: string[] = [];
    runtime.setRebindSession(async (session) => {
      reboundCwds.push(session.sessionManager.getCwd());
    });

    const initialServices = runtime.services;
    expect(runtime.diagnostics).toContainEqual({
      type: 'info',
      message: `Agent Core version: ${AGENT_CORE_VERSION}`,
    });
    expect(runtime.session.agent.state.tools.map((tool) => tool.name)).toEqual([
      'read',
      'bash',
      'edit',
      'write',
      'grep',
      'find',
      'ls',
    ]);

    await runtime.fork(entryId, { position: 'at' });
    activeSessionIds.push(runtime.session.sessionManager.getSessionId());
    const forkServices = runtime.services;
    expect(forkServices).not.toBe(initialServices);
    expect(runtime.cwd).toBe(cwdA);

    await runtime.newSession();
    activeSessionIds.push(runtime.session.sessionManager.getSessionId());
    const newServices = runtime.services;
    expect(newServices).not.toBe(forkServices);
    expect(runtime.cwd).toBe(cwdA);

    const resumedSession = SessionManager.create(cwdB, sessionDir);
    resumedSession.appendMessage({ role: 'user', content: 'resume', timestamp: Date.now() });
    resumedSession.appendMessage(completedAssistantMessage('resumed'));
    const resumedPath = resumedSession.getSessionFile();
    expect(resumedPath).toBeDefined();
    await runtime.switchSession(resumedPath!);
    activeSessionIds.push(runtime.session.sessionManager.getSessionId());
    const resumedServices = runtime.services;
    expect(resumedServices).not.toBe(newServices);
    expect(runtime.cwd).toBe(cwdB);

    const importedSession = SessionManager.create(cwdC, importDir);
    importedSession.appendMessage({ role: 'user', content: 'imported', timestamp: Date.now() });
    importedSession.appendMessage(completedAssistantMessage('imported'));
    const importPath = importedSession.getSessionFile();
    expect(importPath).toBeDefined();
    await runtime.importFromJsonl(importPath!);
    activeSessionIds.push(runtime.session.sessionManager.getSessionId());
    expect(runtime.services).not.toBe(resumedServices);
    expect(runtime.cwd).toBe(cwdC);

    expect(createdHostRuntimes).toHaveLength(5);
    expect(new Set(createdHostRuntimes).size).toBe(5);
    expect(createdHostRuntimes.map((hostRuntime) => hostRuntime.cwd)).toEqual([
      cwdA,
      cwdA,
      cwdA,
      cwdB,
      cwdC,
    ]);
    expect(runtimeRequests.map(({ rootSessionId }) => rootSessionId)).toEqual(activeSessionIds);
    expect(runtimeRequests.map(({ agentDir: requestAgentDir }) => requestAgentDir))
      .toEqual(Array(5).fill(agentDir));
    expect(runtimeRequests.map(({ pathAccess }) => pathAccess))
      .toEqual(Array(5).fill('host'));
    expect(new Set(activeSessionIds).size).toBe(5);
    expect(createdHostRuntimes.map((hostRuntime) => hostRuntime.storage().root)).toEqual(
      activeSessionIds.map((sessionId) => join(
        agentDir,
        'storage',
        'sessions',
        encodeURIComponent(sessionId),
      )),
    );
    expect(createdHostRuntimes.map((hostRuntime) => hostRuntime.storage('agent').root))
      .toEqual(Array(5).fill(join(agentDir, 'storage', 'agent')));
    expect(reboundCwds).toEqual([cwdA, cwdA, cwdB, cwdC]);

    await runtime.dispose();
  });

  it('notifies local host subscribers after every session replacement', async () => {
    const root = await temporaryDirectory();
    const cwdA = join(root, 'workspace-a');
    const cwdB = join(root, 'workspace-b');
    const cwdC = join(root, 'workspace-c');
    const agentDir = join(root, 'agent');
    const sessionDir = join(root, 'sessions');
    const importDir = join(root, 'imports');
    await Promise.all([cwdA, cwdB, cwdC, agentDir, sessionDir, importDir].map(
      (path) => mkdir(path, { recursive: true }),
    ));
    const initialSessionManager = SessionManager.create(cwdA, sessionDir);
    const entryId = initialSessionManager.appendMessage({
      role: 'user', content: 'initial prompt', timestamp: Date.now(),
    });
    initialSessionManager.appendMessage(completedAssistantMessage('initial response'));
    const runtime = await createLocalFelanRuntime({
      cwd: cwdA,
      agentDir,
      homeDir: root,
      sessionDir,
      sessionManager: initialSessionManager,
    });
    const hosts: typeof runtime.localSubagentHost[] = [];
    const observeHost = (host: typeof runtime.localSubagentHost) => {
      hosts.push(host);
    };
    observeHost(runtime.localSubagentHost);
    const detachHostChanges = runtime.subscribeLocalSubagentHost(observeHost);
    const shutdowns: typeof hosts = [];
    const observeShutdown = () => {
      const host = runtime.localSubagentHost;
      const shutdown = host.shutdown.bind(host);
      host.shutdown = async () => {
        shutdowns.push(host);
        await shutdown();
      };
    };

    observeShutdown();
    await runtime.fork(entryId, { position: 'at' });
    expect(shutdowns).toEqual([hosts[0]]);

    observeShutdown();
    await runtime.newSession();
    expect(shutdowns).toEqual(hosts.slice(0, 2));

    const resumedSession = SessionManager.create(cwdB, sessionDir);
    resumedSession.appendMessage({ role: 'user', content: 'resume', timestamp: Date.now() });
    resumedSession.appendMessage(completedAssistantMessage('resumed'));
    observeShutdown();
    await runtime.switchSession(resumedSession.getSessionFile()!);
    expect(shutdowns).toEqual(hosts.slice(0, 3));

    const importedSession = SessionManager.create(cwdC, importDir);
    importedSession.appendMessage({ role: 'user', content: 'imported', timestamp: Date.now() });
    importedSession.appendMessage(completedAssistantMessage('imported'));
    observeShutdown();
    await runtime.importFromJsonl(importedSession.getSessionFile()!);
    expect(shutdowns).toEqual(hosts.slice(0, 4));
    expect(hosts).toHaveLength(5);
    expect(new Set(hosts)).toHaveLength(5);

    detachHostChanges();
    await runtime.dispose();
  });

  it('rebinds a replacement session through Pi InteractiveMode command handling', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent');
    await Promise.all([cwd, agentDir].map((path) => mkdir(path, { recursive: true })));
    const modelRuntime = await createLocalModelRuntime(agentDir);
    const createdHostRuntimes: HostAgentRuntime[] = [];
    const runtimeRequests: LocalAgentRuntimeFactoryRequest[] = [];
    const createRuntime = createLocalSessionRuntimeFactory({
      agentDir,
      homeDir: root,
      modelRuntime,
      extensionPackages: [],
      importExtension: async () => {
        throw new Error('No extensions should be imported');
      },
      runtimeFactory: (request) => {
        runtimeRequests.push(request);
        const hostRuntime = new HostAgentRuntime(request.cwd, request);
        createdHostRuntimes.push(hostRuntime);
        return hostRuntime;
      },
    });
    const runtime = await createAgentSessionRuntime(createRuntime, {
      cwd,
      agentDir,
      sessionManager: SessionManager.inMemory(cwd),
    });
    const initialSession = runtime.session;
    const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const runtimeView = createToolActivityRuntimeView(runtime);
    const mode = new InteractiveMode(runtimeView);

    try {
      await (mode as unknown as { handleClearCommand(): Promise<void> }).handleClearCommand();

      expect(runtime.session).not.toBe(initialSession);
      expect(runtime.services.agentDir).toBe(agentDir);
      expect(createdHostRuntimes.map((hostRuntime) => hostRuntime.cwd)).toEqual([cwd, cwd]);
      expect(createdHostRuntimes.map((hostRuntime) => hostRuntime.storage().root))
        .toEqual(runtimeRequests.map(({ sessionStorageRoot }) => sessionStorageRoot));
      expect(runtimeRequests.map(({ rootSessionId }) => rootSessionId)).toEqual([
        runtimeRequests[0]!.rootSessionId,
        runtime.session.sessionManager.getSessionId(),
      ]);
      expect((runtime.session as unknown as { _extensionMode?: string })._extensionMode).toBe('tui');
      expect(runtime.session.agent.state.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
        'read',
        'bash',
      ]));
      expect(runtime.session.agent.state.tools.map((tool) => tool.name)).not.toContain('spawn_agent');
      expect(runtimeView.session.getToolDefinition('read')?.renderShell).toBe('self');
    } finally {
      mode.stop();
      await runtime.dispose();
      if (previousPiAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousPiAgentDir;
      }
    }
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'felan-tui-runtime-'));
  temporaryPaths.push(path);
  return path;
}

function completedAssistantMessage(text: string) {
  return {
    role: 'assistant' as const,
    content: [{ type: 'text' as const, text }],
    api: 'anthropic-messages' as const,
    provider: 'anthropic',
    model: 'test-model',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop' as const,
    timestamp: Date.now(),
  };
}

function skill(name: string): string {
  return `---\nname: ${name}\ndescription: ${name}\n---\n`;
}
