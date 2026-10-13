vi.mock('../src/providers/process-bootstrap.js', () => ({ initializeLocalDaemonProcess: async () => ({ diagnostics: [], assertConfiguration: () => [] }) }));
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FELAN_BASE_SYSTEM_PROMPT, HostAgentRuntime, SessionManager,
  createAssistantMessageEventStream, getSupportedThinkingLevels, getCurrentTools,
  type ClassifierQuestions,
} from '@felan-ai/agent-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalModelRuntime } from '../src/providers/local-model-runtime.js';
import { getLocalSkillPaths } from '../src/providers/local-resources.js';
import { builtinExtensionPackages } from '../src/providers/extensions.js';
import { composeLocalSession } from './fixtures/local-composition.js';

const temporaryPaths: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(temporaryPaths.splice(0).map(path => rm(path, { force: true, recursive: true })));
});

describe('local provider runtime', () => {
  it('reloads dynamic thinking in each composition without disabling the classifier', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent');
    await Promise.all([cwd, agentDir].map(path => mkdir(path, { recursive: true })));
    const classifier = { classify: vi.fn() };
    for (const dynamic of [false, true]) {
      await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ felanThinking: { dynamic } }));
      const result = await composeLocalSession({ cwd, agentDir, homeDir: root,
        runtimeFactory: request => new HostAgentRuntime(request.cwd, { ...request, classifier }),
      });
      try {
        expect(result.composition.options.runtime.classifier).toBe(classifier);
        expect(result.session.resourceLoader.getExtensions().extensions.some(extension =>
          extension.path === '<inline:@felan-ai/agent-core/dynamic-thinking>')).toBe(dynamic);
        expect(classifier.classify).not.toHaveBeenCalled();
      } finally {
        await result.dispose();
      }
    }
  });

  it.each(['on', 'only'] as const)('keeps code mode %s through Codex tool synchronization', async (mode) => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent');
    await Promise.all([cwd, agentDir].map((path) => mkdir(path, { recursive: true })));
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({
      codemode: { mode },
      builtinExtensions: Object.fromEntries(Object.keys(builtinExtensionPackages).map((name) => [name, name === 'codex'])),
    }));
    const modelRuntime = await createLocalModelRuntime(agentDir);
    const codex = modelRuntime.getModel('openai-codex', 'gpt-6-sol')!;
    const ordinary = modelRuntime.getModel('anthropic', 'claude-opus-5-5')!;
    vi.spyOn(modelRuntime, 'checkAuth').mockResolvedValue({ type: 'api_key' });
    vi.spyOn(modelRuntime, 'hasConfiguredAuth').mockReturnValue(true);
    const runtime = await composeLocalSession({
      cwd, agentDir, homeDir: root, modelRuntime, model: codex,
      extensionPackages: [builtinExtensionPackages.codex],
      runtimeFactory: (request) => new HostAgentRuntime(request.cwd, request),
    });
    try {
      const declarations: string[][] = [];
      runtime.session.agent.streamFunction = (activeModel, context) => {
        declarations.push(getCurrentTools(context.messages).map((tool) => tool.name));
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => stream.push({ type: 'done', reason: 'stop', message: {
          ...completedAssistantMessage('Done'), api: activeModel.api,
          provider: activeModel.provider, model: activeModel.id,
        } }));
        return stream;
      };
      await runtime.session.bindExtensions({ mode: 'print' });
      expect(runtime.session.getActiveToolNames()).toContain('codemode');
      expect(runtime.session.getActiveToolNames()).toContain('apply_patch');
      expect(runtime.session.getActiveToolNames()).not.toContain('write');
      await runtime.session.prompt('Inspect');
      expect(declarations.at(-1)).toContain('codemode');
      expect(declarations.at(-1)!.includes('apply_patch')).toBe(mode === 'on');
      await runtime.session.setModel(ordinary);
      expect(runtime.session.getActiveToolNames()).toContain('codemode');
      expect(runtime.session.getActiveToolNames()).not.toContain('apply_patch');
      expect(runtime.session.getActiveToolNames()).toContain('write');
      await runtime.session.prompt('Inspect again');
      expect(declarations.at(-1)).toContain('codemode');
      expect(declarations.at(-1)!.includes('write')).toBe(mode === 'on');
    } finally {
      await runtime.dispose();
    }
  });

  it('selects effort before an eligible root user turn without a provider call', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent');
    await Promise.all([cwd, agentDir].map((path) => mkdir(path, { recursive: true })));
    const modelRuntime = await createLocalModelRuntime(agentDir);
    const model = modelRuntime.getModel('anthropic', 'claude-opus-5-5');
    expect(model).toBeDefined();
    vi.spyOn(modelRuntime, 'hasConfiguredAuth').mockReturnValue(true);
    const classify = vi.fn().mockImplementation(async (_state, questions: ClassifierQuestions) => effortAnswers(questions, ['low']));
    const runtime = await composeLocalSession({
      cwd, agentDir, homeDir: root, modelRuntime, model: model!, extensionPackages: [],
      runtimeFactory: (request) => new HostAgentRuntime(request.cwd, {
        ...request, classifier: { classify },
      }),
    });
    runtime.session.agent.streamFunction = (activeModel) => {
      const response = { ...completedAssistantMessage('Done'), api: activeModel.api,
        provider: activeModel.provider, model: activeModel.id };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: 'start', partial: { ...response, content: [], stopReason: 'pending' } });
        stream.push({ type: 'done', reason: 'stop', message: response });
      });
      return stream;
    };
    await runtime.session.bindExtensions({ mode: 'print' });
    const defaultThinking = runtime.session.settingsManager.getDefaultThinkingLevel();
    await runtime.session.prompt('Summarize this simply');

    expect(classify.mock.calls.map(([, questions]) => Object.keys(questions)).filter((ids) => ids.includes('thinking:effort')))
      .toEqual([expect.arrayContaining(['thinking:effort'])]);
    expect(runtime.session.thinkingLevel).toBe('low');
    expect(runtime.session.settingsManager.getDefaultThinkingLevel()).toBe(defaultThinking);

    runtime.session.setThinkingLevel('max');
    await runtime.session.prompt('Now investigate deeply');
    expect(classify.mock.calls.map(([, questions]) => Object.keys(questions)).filter((ids) => ids.includes('thinking:effort')))
      .toEqual([expect.arrayContaining(['thinking:effort'])]);
    expect(runtime.session.thinkingLevel).toBe('max');
    await runtime.dispose();
  });

  it.each(['openai-codex', 'openai'] as const)('records a cache-safe %s effort change before the next user turn', async (provider) => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent');
    await Promise.all([cwd, agentDir].map((path) => mkdir(path, { recursive: true })));
    const modelRuntime = await createLocalModelRuntime(agentDir);
    const model = modelRuntime.getModel(provider, 'gpt-6-sol');
    expect(model).toBeDefined();
    vi.spyOn(modelRuntime, 'hasConfiguredAuth').mockReturnValue(true);
    const effortChoices = ['low', 'high'];
    const classify = vi.fn().mockImplementation(async (_state, questions: ClassifierQuestions) =>
      effortAnswers(questions, effortChoices));
    const runtime = await composeLocalSession({
      cwd, agentDir, homeDir: root, modelRuntime, model: model!,
      extensionPackages: [builtinExtensionPackages.codex],
      runtimeFactory: (request) => new HostAgentRuntime(request.cwd, {
        ...request, classifier: { classify },
      }),
    });
    runtime.session.agent.streamFunction = (activeModel) => {
      const response = { ...completedAssistantMessage('Done'), api: activeModel.api,
        provider: activeModel.provider, model: activeModel.id };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: 'start', partial: { ...response, content: [], stopReason: 'pending' } });
        stream.push({ type: 'done', reason: 'stop', message: response });
      });
      return stream;
    };
    await runtime.session.bindExtensions({ mode: 'print' });
    await runtime.session.prompt('Describe the file briefly');
    await runtime.session.prompt('Investigate a concurrency bug');

    expect(effortChoices).toEqual([]);
    expect(runtime.session.sessionManager.getBranch().filter((entry) => (
      entry.type === 'custom' && entry.customType === 'codex-reasoning-update'
    ))).toMatchObject([{ data: { initialEffort: 'low', effort: 'high' } }]);
    await runtime.dispose();
  });

  it('preserves official OpenAI request prefixes through native Responses dispatch', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent');
    await Promise.all([cwd, agentDir].map((path) => mkdir(path, { recursive: true })));
    const modelRuntime = await createLocalModelRuntime(agentDir);
    const model = modelRuntime.getModel('openai', 'gpt-6-sol');
    expect(model?.api).toBe('openai-responses');
    vi.spyOn(modelRuntime, 'hasConfiguredAuth').mockReturnValue(true);
    const effortChoices = ['low', 'high', 'high'];
    const classify = vi.fn().mockImplementation(async (_state, questions: ClassifierQuestions) =>
      effortAnswers(questions, effortChoices));
    const requests: Array<{
      input: Array<{ role?: string; type?: string; reasoning?: { effort: string } }>;
      reasoning?: { effort: string };
      prompt_cache_key?: string;
      prompt_cache_retention?: string;
      prompt_cache_options?: { ttl: string };
    }> = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe('https://api.openai.com/v1/responses');
      requests.push(await request.json());
      const item = {
        type: 'message', role: 'assistant', id: `msg_${requests.length}`, status: 'completed',
        content: [{ type: 'output_text', text: 'Done', annotations: [] }],
      };
      const events = [
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: {
          id: `resp_${requests.length}`, status: 'completed', output: [item],
          usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } },
        } },
      ];
      return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    const runtime = await composeLocalSession({
      cwd, agentDir, homeDir: root, modelRuntime, model: model!,
      extensionPackages: [builtinExtensionPackages.codex],
      runtimeFactory: (request) => new HostAgentRuntime(request.cwd, {
        ...request, classifier: { classify },
      }),
    });
    try {
      runtime.session.agent.streamFunction = (activeModel, context, options) => modelRuntime.streamSimple(
        activeModel, context, { ...options, apiKey: 'sk-test-only', fetch, cacheRetention: 'long' },
      );
      await runtime.session.bindExtensions({ mode: 'print' });
      const defaultThinking = runtime.session.settingsManager.getDefaultThinkingLevel();
      await runtime.session.prompt('Describe the file briefly');
      await runtime.session.prompt('Investigate a concurrency bug');
      await runtime.session.prompt('Continue the investigation');
      expect(effortChoices).toEqual([]);
      expect(runtime.session.settingsManager.getDefaultThinkingLevel()).toBe(defaultThinking);

      runtime.session.setThinkingLevel('medium');
      await runtime.session.prompt('Summarize the findings');

      expect(fetch).toHaveBeenCalledTimes(4);
      expect(classify.mock.calls.filter(([, questions]) => Object.hasOwn(questions, 'thinking:effort'))).toHaveLength(3);
      const [first, second, third, fourth] = requests;
      expect(first!.input.some((item) => item.type === 'configuration_update')).toBe(false);
      expect(first!.prompt_cache_options).toEqual({ ttl: '30m' });
      for (const [index, payload] of requests.entries()) {
        expect(payload).toMatchObject({
          reasoning: { effort: 'low' },
          prompt_cache_key: first!.prompt_cache_key,
        });
        expect(payload.prompt_cache_options).toEqual(first!.prompt_cache_options);
        expect(payload.prompt_cache_retention).toBe(first!.prompt_cache_retention);
        expect(payload.prompt_cache_key).toBe(runtime.session.sessionManager.getSessionId());
        expect(JSON.stringify(payload)).not.toContain('<codex-reasoning-update:');
        if (index > 0) {
          const previous = requests[index - 1]!;
          expect(payload.input.slice(0, previous.input.length)).toEqual(previous.input);
        }
      }
      expect(second!.input.slice(-2)).toMatchObject([
        { type: 'configuration_update', reasoning: { effort: 'high' } }, { role: 'user' },
      ]);
      expect(third!.input.filter((item) => item.type === 'configuration_update')).toEqual([
        { type: 'configuration_update', reasoning: { effort: 'high' } },
      ]);
      expect(fourth!.input.slice(-2)).toMatchObject([
        { type: 'configuration_update', reasoning: { effort: 'medium' } }, { role: 'user' },
      ]);
      expect(runtime.session.sessionManager.getBranch().filter((entry) => (
        entry.type === 'custom' && entry.customType === 'codex-reasoning-update'
      ))).toMatchObject([
        { data: { initialEffort: 'low', effort: 'high' } },
        { data: { initialEffort: 'low', effort: 'medium' } },
      ]);
    } finally {
      await runtime.dispose();
    }
  });

  it.each(['openai-codex', 'openai'] as const)('does not select %s effort when the Codex extension is disabled', async (provider) => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent');
    await Promise.all([cwd, agentDir].map((path) => mkdir(path, { recursive: true })));
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ builtinExtensions: { codex: false } }));
    const modelRuntime = await createLocalModelRuntime(agentDir);
    const model = modelRuntime.getModel(provider, 'gpt-6-sol');
    expect(model).toBeDefined();
    vi.spyOn(modelRuntime, 'hasConfiguredAuth').mockReturnValue(true);
    const classify = vi.fn().mockImplementation(async (_state, questions: ClassifierQuestions) => effortAnswers(questions, ['low']));
    const runtime = await composeLocalSession({
      cwd, agentDir, homeDir: root, modelRuntime, model: model!,
      runtimeFactory: (request) => new HostAgentRuntime(request.cwd, {
        ...request, classifier: { classify },
      }),
    });
    expect(runtime.session.model?.api).toBe(provider === 'openai' ? 'openai-responses' : 'openai-codex-responses');
    expect(runtime.session.resourceLoader.getExtensions().extensions.map(({ path }) => path))
      .not.toContain('<inline:@felan-ai/ext-codex>');
    runtime.session.agent.streamFunction = (activeModel) => {
      const response = { ...completedAssistantMessage('Done'), api: activeModel.api,
        provider: activeModel.provider, model: activeModel.id };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: 'start', partial: { ...response, content: [], stopReason: 'pending' } });
        stream.push({ type: 'done', reason: 'stop', message: response });
      });
      return stream;
    };
    await runtime.session.bindExtensions({ mode: 'print' });
    const original = runtime.session.thinkingLevel;
    await runtime.session.prompt('Summarize the file');
    expect(classify.mock.calls.filter(([, questions]) => Object.hasOwn(questions, 'thinking:effort'))).toEqual([]);
    expect(runtime.session.thinkingLevel).toBe(original);
    await runtime.dispose();
  });

  it('loads GPT-6 Astra from the configured Pi model catalog', async () => {
    const root = await temporaryDirectory();
    const agentDir = join(root, 'agent');
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, 'models.json'), JSON.stringify({
      providers: {
        'openai-codex': {
          models: [{
            id: 'gpt-6-astra',
            name: 'GPT-6 Astra',
            api: 'openai-codex-responses',
            reasoning: true,
            input: ['text', 'image'],
            contextWindow: 272_000,
            maxTokens: 128_000,
            cost: {
              input: 10,
              output: 50,
              cacheRead: 1,
              cacheWrite: 12.5,
              tiers: [{
                inputTokensAbove: 272_000,
                input: 20,
                output: 75,
                cacheRead: 2,
                cacheWrite: 25,
              }],
            },
            thinkingLevelMap: {
              off: null,
              minimal: 'low',
              xhigh: 'xhigh',
              max: 'max',
            },
          }],
        },
      },
    }));

    const modelRuntime = await createLocalModelRuntime(agentDir);
    expect(modelRuntime.getModel('openai-codex', 'gpt-6-astra')).toMatchObject({
      id: 'gpt-6-astra',
      name: 'GPT-6 Astra',
      api: 'openai-codex-responses',
      provider: 'openai-codex',
      reasoning: true,
      input: ['text', 'image'],
      contextWindow: 272_000,
      maxTokens: 128_000,
      cost: {
        input: 10,
        output: 50,
        cacheRead: 1,
        cacheWrite: 12.5,
        tiers: [{
          inputTokensAbove: 272_000,
          input: 20,
          output: 75,
          cacheRead: 2,
          cacheWrite: 25,
        }],
      },
      thinkingLevelMap: {
        off: null,
        minimal: 'low',
        xhigh: 'xhigh',
        max: 'max',
      },
    });
  });

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

  it('uses the Felan provider default when no model preference is saved', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent');
    await Promise.all([cwd, agentDir].map((path) => mkdir(path, { recursive: true })));
    await writeFile(join(agentDir, 'auth.json'), JSON.stringify({
      openai: { type: 'api_key', key: 'test-key' },
    }));

    const runtime = await composeLocalSession({ cwd, agentDir, homeDir: root, modelRuntime: await createLocalModelRuntime(agentDir), sessionManager: SessionManager.inMemory(cwd) });

    expect(runtime.session.model).toMatchObject({ provider: 'openai', id: 'gpt-5.6-sol' });
    await runtime.dispose();
  });

  it('preserves an explicitly saved model over the Felan provider default', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent');
    await Promise.all([cwd, agentDir].map((path) => mkdir(path, { recursive: true })));
    await Promise.all([
      writeFile(join(agentDir, 'auth.json'), JSON.stringify({
        openai: { type: 'api_key', key: 'test-key' },
      })),
      writeFile(join(agentDir, 'settings.json'), JSON.stringify({
        defaultProvider: 'openai',
        defaultModel: 'gpt-5.5',
      })),
    ]);

    const runtime = await composeLocalSession({ cwd, agentDir, homeDir: root, modelRuntime: await createLocalModelRuntime(agentDir), sessionManager: SessionManager.inMemory(cwd) });

    expect(runtime.session.model).toMatchObject({ provider: 'openai', id: 'gpt-5.5' });
    await runtime.dispose();
  });

  it('restores a session model over the Felan provider default', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent');
    await Promise.all([cwd, agentDir].map((path) => mkdir(path, { recursive: true })));
    await writeFile(join(agentDir, 'auth.json'), JSON.stringify({
      openai: { type: 'api_key', key: 'test-key' },
    }));
    const sessionManager = SessionManager.inMemory(cwd);
    sessionManager.appendModelChange('openai', 'gpt-5.5');
    sessionManager.appendMessage({
      role: 'user', content: 'keep the session model', timestamp: Date.now(),
    });

    const runtime = await composeLocalSession({ cwd, agentDir, homeDir: root, modelRuntime: await createLocalModelRuntime(agentDir), sessionManager });

    expect(runtime.session.model).toMatchObject({ provider: 'openai', id: 'gpt-5.5' });
    await runtime.dispose();
  });

  it('uses the Felan root for sessions and loads only configured built-ins, root instructions, and .agents skills', async () => {
    const root = await temporaryDirectory();
    const home = join(root, 'home');
    vi.stubEnv('HOME', home);
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
        codebaseMemory: false,
        markitdown: false,
        mcp: false,
        webAccess: false,
        browser: false,
        backgroundBash: false,
        codex: false,
        rtkOptimizer: false,
        memory: false,
        felanApi: false,
        modelTools: false,
        fusion: false,
        powerline: false,
        outputStyle: false,
        promptHistory: false,
        insights: false,
        sessionTitle: false,
        sessionCompaction: false,
      },
    }));
    await writeFile(join(agentDir, 'APPEND_SYSTEM.md'), 'Local application instructions');
    await writeFile(join(cwd, '.pi', 'APPEND_SYSTEM.md'), 'Ignored project append');
    await writeFile(join(cwd, '.pi', 'mcp.json'), JSON.stringify({
      mcpServers: { untrusted: { command: 'should-not-run' } },
    }));
    await writeFile(join(agentDir, 'mcp.json'), JSON.stringify({
      mcpServers: { untrusted: { command: 'should-not-run' } },
    }));
    await writeFile(join(cwd, 'AGENTS.md'), 'Root project instructions');
    await writeFile(join(cwd, 'CLAUDE.md'), 'Ignored fallback instructions');
    await writeFile(join(projectSkills, 'project-skill', 'SKILL.md'), skill('project-skill'));
    await writeFile(join(userSkills, 'user-skill', 'SKILL.md'), skill('user-skill'));
    await writeFile(join(ignoredSkills, 'ignored-skill', 'SKILL.md'), skill('ignored-skill'));
    const skillPaths = getLocalSkillPaths(cwd, home);

    expect(skillPaths).toEqual([projectSkills, userSkills]);

    const runtime = await composeLocalSession({ cwd, agentDir, homeDir: home });

    expect(runtime.session.sessionManager.getSessionDir()).toBe(join(agentDir, 'sessions'));
    const loadedExtensions = runtime.session.resourceLoader.getExtensions().extensions;
    expect(loadedExtensions.filter((extension) => !extension.hidden)).toEqual([]);
    expect(runtime.session.resourceLoader.getSkills().skills.map(({ name }) => name)).toEqual([
      'project-skill',
      'user-skill',
    ]);
    expect(runtime.session.agent.state.tools.map(({ name }) => name)).not.toContain('Agent');
    for (const nativeTool of ['mcp', 'codemode', 'tool_search']) {
      expect(runtime.session.agent.state.tools.map(({ name }) => name)).not.toContain(nativeTool);
    }
    const systemPrompt = runtime.session.systemPrompt;
    expect(systemPrompt.startsWith(FELAN_BASE_SYSTEM_PROMPT)).toBe(true);
    expect(systemPrompt).not.toContain('Be concise and direct');
    expect(systemPrompt).toContain('Local application instructions');
    expect(systemPrompt).not.toContain('Root project instructions');
    expect(systemPrompt).not.toContain('Ignored fallback instructions');
    expect(systemPrompt).not.toContain('Ignored project append');
    expect(systemPrompt).not.toContain('## Enabled capabilities');
    expect(runtime.session.resourceLoader.getAgentsFiles().agentsFiles).toEqual([]);
    expect(systemPrompt.indexOf('Local application instructions')).toBeLessThan(
      systemPrompt.indexOf('<available_skills>'),
    );
    expect(systemPrompt.indexOf('<available_skills>')).toBeLessThan(
      systemPrompt.indexOf('<cwd>'),
    );

    const transformContext = runtime.session.agent.transformContext;
    if (!transformContext) throw new Error('Expected Pi to install its context transform');
    const transformed = await transformContext([{
      role: 'user',
      content: [{ type: 'text', text: 'Inspect the workspace' }],
      timestamp: 1,
    }]);
    const providerMessages = await runtime.session.agent.convertToLlm(transformed);
    expect(providerMessages[0]?.role).toBe('user');
    expect(JSON.stringify(providerMessages[0])).toContain('Root project instructions');
    expect(JSON.stringify(providerMessages[0])).toContain(join(cwd, 'AGENTS.md'));
    expect(JSON.stringify(providerMessages)).not.toContain('Ignored fallback instructions');

    await runtime.dispose();
  });

  it('loads explicit native Pi extensions only in the local root runtime', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent');
    const extensionPath = join(root, 'extension.mjs');
    await Promise.all([cwd, agentDir].map((path) => mkdir(path, { recursive: true })));
    await writeFile(extensionPath,
      'export default (pi) => pi.registerCommand("root-extension", { description: "root extension", handler: async () => {} });');

    const runtime = await composeLocalSession({ cwd, agentDir, extensionPaths: [extensionPath] });
    expect(runtime.session.resourceLoader.getExtensions().extensions.map((extension) => extension.path))
      .toContain(extensionPath);
    expect(runtime.session.resourceLoader.getExtensions().extensions
      .find((extension) => extension.path === extensionPath)?.commands.has('root-extension')).toBe(true);
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
    const classifier = { classify: vi.fn() };

    const runtime = await composeLocalSession({
      cwd,
      agentDir,
      homeDir: root,
      modelRuntime,
      sessionManager,
      model: model!,
      thinkingLevel: 'high',
      runtimeFactory: (request) => new HostAgentRuntime(request.cwd, { ...request, classifier }),
    });

    expect(runtime.session.model).toBe(model);
    expect(runtime.session.thinkingLevel).toBe('high');
    expect(runtime.session.resourceLoader.getExtensions().extensions.some((extension) => (
      extension.path === '<inline:@felan-ai/agent-core/dynamic-thinking>'
    ))).toBe(false);
    await runtime.dispose();
  });

});

async function temporaryDirectory(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'felan-provider-runtime-')));
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

function effortAnswers(questions: ClassifierQuestions, choices: string[]) {
  return { answers: Object.fromEntries(Object.entries(questions).map(([id, question]) => [id,
    question.type === 'choice' ? { type: 'choice', choice: id === 'thinking:effort' ? choices.shift()
      : id === 'prewalk:route' ? 'regular' : Object.keys(question.criteria)[0] }
      : question.type === 'bool' ? { type: 'bool', probability: 0 } : { type: 'score', score: 0 },
  ])) };
}
