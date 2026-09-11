import {
  client,
  methods,
  type AgentContext,
  type AgentCapabilities,
  type SessionNotification,
} from '@agentclientprotocol/sdk';
import {
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type ModelRuntime,
} from '@felan-ai/agent-core';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFelanAcpService } from '../src/acp/server.js';
import { AcpSessionRegistry } from '../src/acp/session-registry.js';
import type {
  CreateLocalFelanRuntimeOptions,
  LocalFelanRuntime,
} from '../src/runtime.js';

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('ACP session lifecycle', () => {
  it('advertises only implemented lifecycle capabilities', async () => {
    const service = createFelanAcpService();
    const app = client({ name: 'test-client' });

    await app.connectWith(service.app, async (connection) => {
      const initialized = await connection.request(methods.agent.initialize, {
        ...initializeRequest(),
        clientCapabilities: { terminal: true },
      });
      expect(initialized.protocolVersion).toBe(1);
      expect(initialized.agentCapabilities).toEqual({
        loadSession: true,
        sessionCapabilities: { close: {} },
      } satisfies AgentCapabilities);
      expect(initialized.authMethods).toBeUndefined();
    });

    await service.dispose();
  });

  it('advertises terminal login only when the client supports terminal authentication', async () => {
    const service = createFelanAcpService();
    const app = client({ name: 'test-client' });

    await app.connectWith(service.app, async (connection) => {
      const initialized = await connection.request(methods.agent.initialize, {
        ...initializeRequest(),
        clientCapabilities: { auth: { terminal: true } },
      });

      expect(initialized.authMethods).toEqual([{
        id: 'felan-terminal-login',
        name: 'Log in to Felan Code',
        description: 'Configure a model provider for Felan Code in an interactive terminal.',
        type: 'terminal',
        args: ['login'],
      }]);
    });

    await service.dispose();
  });

  it('advertises terminal login for the registry legacy metadata signal alone', async () => {
    const service = createFelanAcpService();
    const app = client({ name: 'test-client' });

    await app.connectWith(service.app, async (connection) => {
      const initialized = await connection.request(methods.agent.initialize, {
        ...initializeRequest(),
        clientCapabilities: { _meta: { 'terminal-auth': true } },
      });

      expect(initialized.authMethods).toEqual([{
        id: 'felan-terminal-login',
        name: 'Log in to Felan Code',
        description: 'Configure a model provider for Felan Code in an interactive terminal.',
        type: 'terminal',
        args: ['login'],
      }]);
    });

    await service.dispose();
  });

  it('returns auth-required until externally saved credentials are synchronized', async () => {
    const harness = await runtimeHarness();
    let storedCredential = false;
    let synchronizedCredential = false;
    const refresh = vi.fn(async () => {
      synchronizedCredential = storedCredential;
      return { aborted: false, errors: new Map() };
    });
    const service = createFelanAcpService({
      ...testOptions(harness),
      createModelRuntime: async () => ({
        getProviders: () => [{ id: 'test-provider' }],
        hasConfiguredAuth: () => synchronizedCredential,
        refresh,
      }) as unknown as ModelRuntime,
    });
    const app = client({ name: 'test-client' });

    await app.connectWith(service.app, async (connection) => {
      await connection.request(methods.agent.initialize, {
        ...initializeRequest(),
        clientCapabilities: { auth: { terminal: true } },
      });
      const firstAttempt = connection.request(
        methods.agent.session.new,
        newSessionRequest(harness.cwd),
      );
      await expect(firstAttempt).rejects.toMatchObject({
        code: -32000,
        message: expect.stringContaining('Authentication required'),
      });
      expect(harness.runtimes).toHaveLength(0);

      storedCredential = true;
      await expect(connection.request(
        methods.agent.session.new,
        newSessionRequest(harness.cwd),
      )).resolves.toEqual({ sessionId: 'session-1' });
    });

    expect(refresh).toHaveBeenCalledTimes(2);
    await service.dispose();
  });

  it('creates isolated sessions and disposes them on close or server shutdown', async () => {
    const harness = await runtimeHarness();
    const service = createFelanAcpService(testOptions(harness));
    const app = client({ name: 'test-client' });

    await app.connectWith(service.app, async (connection) => {
      await connection.request(methods.agent.initialize, initializeRequest());
      const first = await connection.request(methods.agent.session.new, newSessionRequest(harness.cwd));
      const second = await connection.request(methods.agent.session.new, newSessionRequest(harness.cwd));

      expect(first.sessionId).not.toBe(second.sessionId);
      expect(harness.runtimes).toHaveLength(2);
      expect(harness.modelRuntimeCreations).toBe(1);
      expect(harness.runtimes.every(({ bindExtensions }) => bindExtensions.mock.calls[0]?.[0].mode === 'rpc')).toBe(true);

      await connection.request(methods.agent.session.close, { sessionId: first.sessionId });
      expect(harness.runtimes[0]?.dispose).toHaveBeenCalledOnce();
      expect(harness.runtimes[1]?.dispose).not.toHaveBeenCalled();
    });

    await service.dispose();
    expect(harness.runtimes[1]?.dispose).toHaveBeenCalledOnce();
  });

  it('binds advertised form elicitation to root and local subagent sessions', async () => {
    const harness = await runtimeHarness();
    const service = createFelanAcpService(testOptions(harness));
    const app = client({ name: 'test-client' });

    await app.connectWith(service.app, async (connection) => {
      await connection.request(methods.agent.initialize, {
        ...initializeRequest(),
        clientCapabilities: { elicitation: { form: {} } },
      });
      await connection.request(methods.agent.session.new, newSessionRequest(harness.cwd));

      const runtime = harness.runtimes[0]!;
      const binding = runtime.bindExtensions.mock.calls[0]?.[0];
      expect(binding).toMatchObject({ mode: 'rpc', uiContext: expect.any(Object) });
      expect(runtime.runtimeOptions.inlineExtensions).toHaveLength(1);
      expect(runtime.runtimeOptions.subagentUiContext).toBe(binding.uiContext);
    });

    await service.dispose();
  });

  it('reports non-informational runtime diagnostics through the host channel', async () => {
    const harness = await runtimeHarness({
      diagnostics: [
        { type: 'info', message: 'version detail' },
        { type: 'warning', message: 'configuration warning' },
      ],
    });
    const diagnostics: string[] = [];
    const service = createFelanAcpService({
      ...testOptions(harness),
      writeDiagnostic: (message) => diagnostics.push(message),
    });
    const app = client({ name: 'test-client' });

    await app.connectWith(service.app, async (connection) => {
      await connection.request(methods.agent.initialize, initializeRequest());
      await connection.request(methods.agent.session.new, newSessionRequest(harness.cwd));
    });

    expect(diagnostics).toEqual(['configuration warning']);
    await service.dispose();
  });

  it('validates cwd, additional roots, and unsupported MCP before creating a runtime', async () => {
    const harness = await runtimeHarness();
    const service = createFelanAcpService(testOptions(harness));
    const app = client({ name: 'test-client' });
    const file = join(harness.root, 'file.txt');
    await writeFile(file, 'not a directory');

    await app.connectWith(service.app, async (connection) => {
      await connection.request(methods.agent.initialize, initializeRequest());
      await expect(connection.request(methods.agent.session.new, newSessionRequest('relative')))
        .rejects.toThrow('cwd must be an absolute path');
      await expect(connection.request(methods.agent.session.new, newSessionRequest(file)))
        .rejects.toThrow('cwd must be a directory');
      await expect(connection.request(methods.agent.session.new, {
        ...newSessionRequest(harness.cwd),
        additionalDirectories: [harness.root],
      })).rejects.toThrow('Additional directories are not supported');
    });

    expect(harness.runtimes).toHaveLength(0);
    await service.dispose();
  });

  it('ignores client-provided MCP servers without injecting runtime extensions', async () => {
    const harness = await runtimeHarness();
    const service = createFelanAcpService(testOptions(harness));
    const app = client({ name: 'test-client' });

    await app.connectWith(service.app, async (connection) => {
      await connection.request(methods.agent.initialize, initializeRequest());
      await expect(connection.request(methods.agent.session.new, {
        ...newSessionRequest(harness.cwd),
        mcpServers: [
          {
            name: 'local-tools',
            command: process.execPath,
            args: ['server.js'],
            env: [{ name: 'EXPLICIT_VALUE', value: 'configured' }],
          },
          {
            type: 'http',
            name: 'remote-http',
            url: 'https://example.com/mcp',
            headers: [{ name: 'Authorization', value: 'Bearer ignored-secret' }],
          },
          {
            type: 'sse',
            name: 'remote-sse',
            url: 'https://example.com/events',
            headers: [],
          },
          {
            type: 'acp',
            name: 'client-provided',
            serverId: 'client-server',
          },
        ],
      })).resolves.toEqual({ sessionId: 'session-1' });
    });

    const options = harness.runtimes[0]?.runtimeOptions;
    expect(options?.inlineExtensions).toHaveLength(1);
    expect(options).not.toHaveProperty('createRootInlineExtensions');
    expect(JSON.stringify(options)).not.toContain('configured');
    expect(JSON.stringify(options)).not.toContain('ignored-secret');
    await service.dispose();
  });

  it('loads an exact persisted session and replays its conversation before responding', async () => {
    const harness = await runtimeHarness();
    const stored = SessionManager.inMemory(harness.cwd, { id: 'stored-session' });
    stored.appendMessage(userMessage('previous question'));
    stored.appendMessage(assistantMessage('previous answer'));
    const currentQuestionId = stored.appendMessage(userMessage('current question'));
    stored.appendMessage(assistantMessage('current answer'));
    stored.appendCompaction('compacted context', currentQuestionId, 100);
    const updates: SessionNotification[] = [];
    const service = createFelanAcpService(testOptions(harness, async (sessionId) => (
      sessionId === 'stored-session' ? stored : undefined
    )));
    const app = client({ name: 'test-client' }).onNotification(
      methods.client.session.update,
      ({ params }) => { updates.push(params); },
    );

    await app.connectWith(service.app, async (connection) => {
      await connection.request(methods.agent.initialize, initializeRequest());
      await connection.request(methods.agent.session.load, {
        sessionId: 'stored-session',
        cwd: harness.cwd,
        mcpServers: [{
          type: 'http',
          name: 'ignored-on-load',
          url: 'https://example.com/mcp',
          headers: [],
        }],
      });

      expect(updates.map(({ update }) => update)).toEqual([
        expect.objectContaining({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'previous question' } }),
        expect.objectContaining({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'previous answer' } }),
        expect.objectContaining({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'current question' } }),
        expect.objectContaining({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'current answer' } }),
      ]);
      await expect(connection.request(methods.agent.session.load, {
        sessionId: 'stored-session',
        cwd: harness.cwd,
        mcpServers: [],
      })).rejects.toThrow('Session is already active');
      await expect(connection.request(methods.agent.session.load, {
        sessionId: 'missing-session',
        cwd: harness.cwd,
        mcpServers: [],
      })).rejects.toThrow();
    });

    await service.dispose();
  });

  it('reserves a persisted session while it is loading', async () => {
    const harness = await runtimeHarness();
    const stored = SessionManager.inMemory(harness.cwd, { id: 'stored-session' });
    let releaseOpen!: () => void;
    let markOpenStarted!: () => void;
    const openStarted = new Promise<void>((resolve) => { markOpenStarted = resolve; });
    const openGate = new Promise<void>((resolve) => { releaseOpen = resolve; });
    let openCalls = 0;
    const service = createFelanAcpService(testOptions(harness, async () => {
      openCalls += 1;
      markOpenStarted();
      await openGate;
      return stored;
    }));
    const app = client({ name: 'test-client' });

    await app.connectWith(service.app, async (connection) => {
      await connection.request(methods.agent.initialize, initializeRequest());
      const request = {
        sessionId: 'stored-session',
        cwd: harness.cwd,
        mcpServers: [],
      };
      const first = connection.request(methods.agent.session.load, request);
      await openStarted;
      const duplicate = connection.request(methods.agent.session.load, request);
      releaseOpen();

      await expect(first).resolves.toEqual({});
      await expect(duplicate).rejects.toThrow(/Session is already (active|loading)/);
    });

    expect(openCalls).toBe(1);
    expect(harness.runtimes).toHaveLength(1);
    await service.dispose();
  });

  it('keeps a restored session private until history replay completes', async () => {
    const harness = await runtimeHarness();
    const stored = SessionManager.inMemory(harness.cwd, { id: 'stored-session' });
    stored.appendMessage(userMessage('history'));
    let releaseUpdate!: () => void;
    let markUpdateStarted!: () => void;
    const updateStarted = new Promise<void>((resolve) => { markUpdateStarted = resolve; });
    const updateGate = new Promise<void>((resolve) => { releaseUpdate = resolve; });
    const registry = new AcpSessionRegistry(testOptions(harness, async () => stored));
    const context = {
      notify: vi.fn(async () => {
        markUpdateStarted();
        await updateGate;
      }),
    } as unknown as AgentContext;
    const loading = registry.loadSession({
      sessionId: 'stored-session',
      cwd: harness.cwd,
      mcpServers: [],
    }, context);
    await updateStarted;

    await expect(registry.prompt({
      sessionId: 'stored-session',
      prompt: [{ type: 'text', text: 'too early' }],
    }, context)).rejects.toThrow('Session is still loading');
    expect(() => registry.closeSession({ sessionId: 'stored-session' }))
      .toThrow('Session is still loading');
    releaseUpdate();
    await expect(loading).resolves.toEqual({});
    await expect(registry.prompt({
      sessionId: 'stored-session',
      prompt: [{ type: 'text', text: 'ready' }],
    }, context)).resolves.toEqual({ stopReason: 'end_turn' });

    await registry.dispose();
  });

  it('does not reload a session until its previous runtime has closed', async () => {
    const harness = await runtimeHarness();
    let releaseDispose!: () => void;
    const disposeGate = new Promise<void>((resolve) => { releaseDispose = resolve; });
    const service = createFelanAcpService(testOptions(harness, async (sessionId) => (
      SessionManager.inMemory(harness.cwd, { id: sessionId })
    )));
    const app = client({ name: 'test-client' });

    await app.connectWith(service.app, async (connection) => {
      await connection.request(methods.agent.initialize, initializeRequest());
      const created = await connection.request(methods.agent.session.new, newSessionRequest(harness.cwd));
      harness.runtimes[0]?.dispose.mockImplementationOnce(async () => disposeGate);
      const closing = connection.request(methods.agent.session.close, { sessionId: created.sessionId });
      await vi.waitFor(() => expect(harness.runtimes[0]?.dispose).toHaveBeenCalledOnce());

      await expect(connection.request(methods.agent.session.load, {
        sessionId: created.sessionId,
        cwd: harness.cwd,
        mcpServers: [],
      })).rejects.toThrow('Session is closing');
      releaseDispose();
      await expect(closing).resolves.toEqual({});
      await expect(connection.request(methods.agent.session.load, {
        sessionId: created.sessionId,
        cwd: harness.cwd,
        mcpServers: [],
      })).resolves.toEqual({});
    });

    expect(harness.runtimes).toHaveLength(2);
    await service.dispose();
  });

  it('rejects concurrent prompts, cancels the active turn, and accepts a later prompt', async () => {
    const harness = await runtimeHarness({ holdFirstPrompt: true });
    const updates: SessionNotification[] = [];
    const service = createFelanAcpService(testOptions(harness));
    const app = client({ name: 'test-client' }).onNotification(
      methods.client.session.update,
      ({ params }) => { updates.push(params); },
    );

    await app.connectWith(service.app, async (connection) => {
      await connection.request(methods.agent.initialize, initializeRequest());
      const created = await connection.request(methods.agent.session.new, newSessionRequest(harness.cwd));
      const first = connection.request(methods.agent.session.prompt, {
        sessionId: created.sessionId,
        prompt: [{ type: 'text', text: 'first' }],
      });
      await vi.waitFor(() => expect(harness.runtimes[0]?.prompt).toHaveBeenCalledOnce());

      await expect(connection.request(methods.agent.session.prompt, {
        sessionId: created.sessionId,
        prompt: [{ type: 'text', text: 'second' }],
      })).rejects.toThrow('Only one prompt may run per session');

      await connection.notify(methods.agent.session.cancel, { sessionId: created.sessionId });
      await expect(first).resolves.toEqual({ stopReason: 'cancelled' });
      await expect(connection.request(methods.agent.session.prompt, {
        sessionId: created.sessionId,
        prompt: [{ type: 'resource_link', name: 'README', uri: 'file:///workspace/README.md' }],
      })).resolves.toEqual({ stopReason: 'end_turn' });

      expect(harness.runtimes[0]?.abort).toHaveBeenCalledOnce();
      expect(harness.runtimes[0]?.prompt).toHaveBeenLastCalledWith(
        'Resource link: README\nURI: file:///workspace/README.md',
        expect.objectContaining({ expandPromptTemplates: false, source: 'rpc' }),
      );
      expect(updates.some(({ update }) => update.sessionUpdate === 'agent_message_chunk')).toBe(true);
    });

    await service.dispose();
  });

  it('streams assistant updates before prompt completion', async () => {
    const harness = await runtimeHarness({ holdFirstPrompt: true, streamBeforeHold: true });
    const updates: SessionNotification[] = [];
    const service = createFelanAcpService(testOptions(harness));
    const app = client({ name: 'test-client' }).onNotification(
      methods.client.session.update,
      ({ params }) => { updates.push(params); },
    );

    await app.connectWith(service.app, async (connection) => {
      await connection.request(methods.agent.initialize, initializeRequest());
      const created = await connection.request(methods.agent.session.new, newSessionRequest(harness.cwd));
      let settled = false;
      const prompting = connection.request(methods.agent.session.prompt, {
        sessionId: created.sessionId,
        prompt: [{ type: 'text', text: 'stream' }],
      }).finally(() => { settled = true; });

      await vi.waitFor(() => expect(updates.some(({ update }) => (
        update.sessionUpdate === 'agent_message_chunk'
        && update.content.type === 'text'
        && update.content.text === 'working'
      ))).toBe(true));
      expect(settled).toBe(false);
      await connection.notify(methods.agent.session.cancel, { sessionId: created.sessionId });
      await expect(prompting).resolves.toEqual({ stopReason: 'cancelled' });
    });

    await service.dispose();
  });

  it('suppresses prompt updates while closing an active session', async () => {
    const harness = await runtimeHarness({ holdFirstPrompt: true });
    const updates: SessionNotification[] = [];
    const service = createFelanAcpService(testOptions(harness));
    const app = client({ name: 'test-client' }).onNotification(
      methods.client.session.update,
      ({ params }) => { updates.push(params); },
    );

    await app.connectWith(service.app, async (connection) => {
      await connection.request(methods.agent.initialize, initializeRequest());
      const created = await connection.request(methods.agent.session.new, newSessionRequest(harness.cwd));
      const prompting = connection.request(methods.agent.session.prompt, {
        sessionId: created.sessionId,
        prompt: [{ type: 'text', text: 'close me' }],
      });
      await vi.waitFor(() => expect(harness.runtimes[0]?.prompt).toHaveBeenCalledOnce());

      const closing = connection.request(methods.agent.session.close, { sessionId: created.sessionId });
      await expect(prompting).resolves.toEqual({ stopReason: 'cancelled' });
      await expect(closing).resolves.toEqual({});
    });

    expect(updates.map(({ update }) => update.sessionUpdate)).toEqual(['user_message_chunk']);
    expect(harness.runtimes[0]?.abort).toHaveBeenCalledOnce();
    expect(harness.runtimes[0]?.dispose).toHaveBeenCalledOnce();
    await service.dispose();
  });

  it('allows another session to finish while the first session is prompting', async () => {
    const harness = await runtimeHarness({ holdFirstPrompt: true });
    const service = createFelanAcpService(testOptions(harness));
    const app = client({ name: 'test-client' });

    await app.connectWith(service.app, async (connection) => {
      await connection.request(methods.agent.initialize, initializeRequest());
      const first = await connection.request(methods.agent.session.new, newSessionRequest(harness.cwd));
      const second = await connection.request(methods.agent.session.new, newSessionRequest(harness.cwd));
      const firstPrompt = connection.request(methods.agent.session.prompt, {
        sessionId: first.sessionId,
        prompt: [{ type: 'text', text: 'first' }],
      });
      await vi.waitFor(() => expect(harness.runtimes[0]?.prompt).toHaveBeenCalledOnce());

      await expect(connection.request(methods.agent.session.prompt, {
        sessionId: second.sessionId,
        prompt: [{ type: 'text', text: 'second' }],
      })).resolves.toEqual({ stopReason: 'end_turn' });
      await connection.notify(methods.agent.session.cancel, { sessionId: first.sessionId });
      await expect(firstPrompt).resolves.toEqual({ stopReason: 'cancelled' });
    });

    await service.dispose();
  });

  it('returns cancelled when cancellation arrives while completed updates are flushing', async () => {
    const harness = await runtimeHarness();
    let releaseNotification!: () => void;
    let markNotificationStarted!: () => void;
    const notificationStarted = new Promise<void>((resolve) => { markNotificationStarted = resolve; });
    const notificationGate = new Promise<void>((resolve) => { releaseNotification = resolve; });
    let holdNotifications = true;
    const context = {
      notify: vi.fn(async () => {
        if (!holdNotifications) return;
        markNotificationStarted();
        await notificationGate;
      }),
    } as unknown as AgentContext;
    const registry = new AcpSessionRegistry(testOptions(harness));
    const created = await registry.newSession(newSessionRequest(harness.cwd), context);
    const prompting = registry.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'finish then cancel' }],
    }, context);
    let settled = false;
    void prompting.then(() => { settled = true; });
    await notificationStarted;

    expect(settled).toBe(false);
    await registry.cancel(created.sessionId);
    holdNotifications = false;
    releaseNotification();
    await expect(prompting).resolves.toEqual({ stopReason: 'cancelled' });
    await expect(registry.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'next prompt' }],
    }, context)).resolves.toEqual({ stopReason: 'end_turn' });

    await registry.dispose();
  });

  it('re-aborts a prompt cancelled during asynchronous preflight', async () => {
    const harness = await runtimeHarness({ holdPreflight: true, holdFirstPrompt: true });
    const registry = new AcpSessionRegistry(testOptions(harness));
    const context = { notify: vi.fn(async () => {}) } as unknown as AgentContext;
    const created = await registry.newSession(newSessionRequest(harness.cwd), context);
    const prompting = registry.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'cancel in preflight' }],
    }, context);
    await harness.preflightStarted;

    await registry.cancel(created.sessionId);
    harness.releasePreflight();
    await expect(prompting).resolves.toEqual({ stopReason: 'cancelled' });
    expect(harness.runtimes[0]?.abort).toHaveBeenCalledTimes(2);
    await expect(registry.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'still usable' }],
    }, context)).resolves.toEqual({ stopReason: 'end_turn' });

    await registry.dispose();
  });

  it('sanitizes prompt failures returned to the client', async () => {
    const harness = await runtimeHarness({
      promptError: new Error('provider rejected Bearer raw-secret-token'),
    });
    const registry = new AcpSessionRegistry(testOptions(harness));
    const context = { notify: vi.fn(async () => {}) } as unknown as AgentContext;
    const created = await registry.newSession(newSessionRequest(harness.cwd), context);

    const error = await registry.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'fail safely' }],
    }, context).catch((failure: unknown) => failure);

    expect(error).toMatchObject({ code: -32603 });
    expect(String(error)).toContain('Bearer [REDACTED_TOKEN]');
    expect(String(error)).not.toContain('raw-secret-token');
    await registry.dispose();
  });

  it('maps provider length and refusal stops to ACP stop reasons', async () => {
    const context = { notify: vi.fn(async () => {}) } as unknown as AgentContext;
    for (const scenario of [
      { assistantStopReason: 'length' as const, expected: 'max_tokens' as const },
      { assistantStopReason: 'stop' as const, rawStopReason: 'refusal', expected: 'refusal' as const },
    ]) {
      const harness = await runtimeHarness(scenario);
      const registry = new AcpSessionRegistry(testOptions(harness));
      const created = await registry.newSession(newSessionRequest(harness.cwd), context);

      await expect(registry.prompt({
        sessionId: created.sessionId,
        prompt: [{ type: 'text', text: 'stop' }],
      }, context)).resolves.toEqual({ stopReason: scenario.expected });
      await registry.dispose();
    }
  });

  it('joins the active prompt before disposal even when abort reports a failure', async () => {
    const harness = await runtimeHarness({ holdFirstPrompt: true });
    const service = createFelanAcpService(testOptions(harness));
    const app = client({ name: 'test-client' });

    await app.connectWith(service.app, async (connection) => {
      await connection.request(methods.agent.initialize, initializeRequest());
      const created = await connection.request(methods.agent.session.new, newSessionRequest(harness.cwd));
      const prompting = connection.request(methods.agent.session.prompt, {
        sessionId: created.sessionId,
        prompt: [{ type: 'text', text: 'close after abort failure' }],
      });
      await vi.waitFor(() => expect(harness.runtimes[0]?.prompt).toHaveBeenCalledOnce());
      harness.runtimes[0]?.abort.mockRejectedValueOnce(new Error('abort failed'));

      const closing = connection.request(methods.agent.session.close, { sessionId: created.sessionId });
      await vi.waitFor(() => expect(harness.runtimes[0]?.abort).toHaveBeenCalledOnce());
      expect(harness.runtimes[0]?.dispose).not.toHaveBeenCalled();
      harness.runtimes[0]?.releasePrompt();

      await expect(prompting).resolves.toEqual({ stopReason: 'cancelled' });
      await expect(closing).rejects.toThrow('Internal error');
      expect(harness.runtimes[0]?.dispose).toHaveBeenCalledOnce();
      await expect(service.dispose()).rejects.toThrow('Failed to close ACP sessions');
    });
  });

  it('awaits and discards a runtime that finishes creating during shutdown', async () => {
    const harness = await runtimeHarness();
    let releaseCreation!: () => void;
    let markCreationStarted!: () => void;
    const creationStarted = new Promise<void>((resolve) => { markCreationStarted = resolve; });
    const creationGate = new Promise<void>((resolve) => { releaseCreation = resolve; });
    const service = createFelanAcpService({
      ...testOptions(harness),
      createRuntime: async (options) => {
        markCreationStarted();
        await creationGate;
        return harness.createRuntime(options);
      },
    });
    const app = client({ name: 'test-client' });

    await app.connectWith(service.app, async (connection) => {
      await connection.request(methods.agent.initialize, initializeRequest());
      const creating = connection.request(methods.agent.session.new, newSessionRequest(harness.cwd));
      await creationStarted;
      const disposing = service.dispose();
      expect(service.dispose()).toBe(disposing);
      releaseCreation();

      await expect(creating).rejects.toThrow('ACP server is closed');
      await expect(disposing).resolves.toBeUndefined();
    });

    expect(harness.runtimes).toHaveLength(1);
    expect(harness.runtimes[0]?.dispose).toHaveBeenCalledOnce();
  });

  it('reports a prior close cleanup failure after cleaning up the other sessions', async () => {
    const harness = await runtimeHarness();
    const service = createFelanAcpService(testOptions(harness));
    const app = client({ name: 'test-client' });

    await app.connectWith(service.app, async (connection) => {
      await connection.request(methods.agent.initialize, initializeRequest());
      const first = await connection.request(methods.agent.session.new, newSessionRequest(harness.cwd));
      await connection.request(methods.agent.session.new, newSessionRequest(harness.cwd));
      harness.runtimes[0]?.dispose.mockRejectedValueOnce(new Error('dispose failed'));

      await expect(connection.request(methods.agent.session.close, { sessionId: first.sessionId }))
        .rejects.toThrow('Internal error');
      await expect(service.dispose()).rejects.toThrow('Failed to close ACP sessions');
    });

    expect(harness.runtimes[0]?.dispose).toHaveBeenCalledOnce();
    expect(harness.runtimes[1]?.dispose).toHaveBeenCalledOnce();
  });
});

interface RuntimeRecord {
  readonly dispose: ReturnType<typeof vi.fn>;
  readonly bindExtensions: ReturnType<typeof vi.fn>;
  readonly prompt: ReturnType<typeof vi.fn>;
  readonly abort: ReturnType<typeof vi.fn>;
  readonly releasePrompt: () => void;
  readonly runtimeOptions: CreateLocalFelanRuntimeOptions;
}

async function runtimeHarness(options: {
  readonly holdPreflight?: boolean;
  readonly holdFirstPrompt?: boolean;
  readonly streamBeforeHold?: boolean;
  readonly promptError?: Error;
  readonly assistantStopReason?: 'stop' | 'length';
  readonly rawStopReason?: string;
  readonly diagnostics?: readonly {
    readonly type: 'info' | 'warning' | 'error';
    readonly message: string;
  }[];
} = {}) {
  let nextId = 0;
  let modelRuntimeCreations = 0;
  let markPreflightStarted!: () => void;
  let releasePreflight!: () => void;
  const preflightStarted = new Promise<void>((resolve) => { markPreflightStarted = resolve; });
  const preflightGate = new Promise<void>((resolve) => { releasePreflight = resolve; });
  const runtimes: RuntimeRecord[] = [];
  const root = await temporaryDirectory();
  const cwd = join(root, 'workspace');
  const agentDir = join(root, 'agent');
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  return {
    root,
    cwd,
    agentDir,
    runtimes,
    preflightStarted,
    releasePreflight,
    get modelRuntimeCreations() { return modelRuntimeCreations; },
    createModelRuntime: async () => {
      modelRuntimeCreations += 1;
      return {
        getProviders: () => [{ id: 'test-provider' }],
        hasConfiguredAuth: () => true,
      } as unknown as ModelRuntime;
    },
    createRuntime: async (runtimeOptions: CreateLocalFelanRuntimeOptions) => {
      const holdFirstPrompt = options.holdFirstPrompt === true && runtimes.length === 0;
      const sessionCwd = runtimeOptions.cwd!;
      const manager = runtimeOptions.sessionManager
        ?? SessionManager.inMemory(sessionCwd, { id: `session-${++nextId}` });
      const messages: AgentSession['messages'] = [];
      const listeners = new Set<(event: AgentSessionEvent) => void>();
      const emit = (event: AgentSessionEvent) => {
        for (const listener of listeners) listener(event);
      };
      let releaseFirst: (() => void) | undefined;
      let promptCount = 0;
      const bindExtensions = vi.fn(async () => {});
      const prompt = vi.fn(async (
        text: string,
        promptOptions?: { readonly preflightResult?: (accepted: boolean) => void },
      ) => {
        promptCount += 1;
        if (options.holdPreflight) {
          markPreflightStarted();
          await preflightGate;
        }
        if (options.promptError) {
          promptOptions?.preflightResult?.(false);
          throw options.promptError;
        }
        promptOptions?.preflightResult?.(true);
        const user = userMessage(text);
        messages.push(user);
        emit({ type: 'message_start', message: user });
        emit({ type: 'message_end', message: user });
        manager.appendMessage(user);
        emit({ type: 'message_start', message: assistantMessage('') });
        if (holdFirstPrompt && options.streamBeforeHold) {
          const partial = assistantMessage('working');
          emit({
            type: 'message_update',
            message: partial,
            assistantMessageEvent: {
              type: 'text_delta',
              contentIndex: 0,
              delta: 'working',
              partial,
            },
          });
        }
        let reason: 'stop' | 'length' | 'aborted' = options.assistantStopReason ?? 'stop';
        if (holdFirstPrompt && promptCount === 1) {
          reason = await new Promise<'stop' | 'aborted'>((resolvePrompt) => {
            releaseFirst = () => resolvePrompt('aborted');
          });
        }
        const assistant = assistantMessage(
          reason === 'aborted' ? 'cancelled' : `answer: ${text}`,
          reason,
          options.rawStopReason,
        );
        messages.push(assistant);
        emit({ type: 'message_end', message: assistant });
        manager.appendMessage(assistant);
      });
      const releasePrompt = () => { releaseFirst?.(); };
      const abort = vi.fn(async () => { releasePrompt(); });
      const dispose = vi.fn(async () => {});
      runtimes.push({
        dispose,
        bindExtensions,
        prompt,
        abort,
        releasePrompt,
        runtimeOptions,
      });
      return {
        diagnostics: options.diagnostics ?? [],
        session: {
          sessionManager: manager,
          bindExtensions,
          subscribe: (listener: (event: AgentSessionEvent) => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          prompt,
          abort,
          get messages() { return messages; },
        },
        dispose,
      } as unknown as LocalFelanRuntime;
    },
  };
}

type Harness = Awaited<ReturnType<typeof runtimeHarness>>;

function testOptions(
  harness: Harness,
  openSession?: (sessionId: string, cwd: string, agentDir: string) => Promise<SessionManager | undefined>,
) {
  return {
    agentDir: harness.agentDir,
    createModelRuntime: harness.createModelRuntime,
    createRuntime: harness.createRuntime,
    ...(openSession === undefined ? {} : { openSession }),
  };
}

function initializeRequest() {
  return {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: 'test-client', version: '1.0.0' },
  };
}

function newSessionRequest(cwd: string) {
  return { cwd, mcpServers: [] };
}

function userMessage(text: string) {
  return { role: 'user' as const, content: text, timestamp: Date.now() };
}

function assistantMessage(
  text: string,
  stopReason: 'stop' | 'length' | 'aborted' = 'stop',
  rawStopReason?: string,
) {
  return {
    role: 'assistant' as const,
    content: [{ type: 'text' as const, text }],
    api: 'anthropic-messages' as const,
    provider: 'test',
    model: 'test-model',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    ...(rawStopReason === undefined ? {} : { rawStopReason }),
    timestamp: Date.now(),
  };
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'felan-acp-'));
  temporaryPaths.push(path);
  return path;
}
