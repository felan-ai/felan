import {
  type AgentRuntime,
  type Api,
  type ExtensionContext,
  type FelanExtensionAPI,
  type Model,
} from '@felan-ai/agent-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import backgroundBashExtension, {
  BackgroundBashManager,
  type BackgroundBashJob,
  type BackgroundBashStatus,
} from '../src/index.js';

type Handler = (event: any, ctx: ExtensionContext) => unknown;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('background bash extension activation', () => {
  it('does not register tools for OpenAI models', async () => {
    const harness = createHarness();
    await backgroundBashExtension(harness.pi);

    await harness.emit('session_start', {}, context('openai'));

    expect(harness.registerTool).not.toHaveBeenCalled();
    expect(harness.registerCommand).not.toHaveBeenCalled();
    expect(harness.registerShortcut).not.toHaveBeenCalled();
  });

  it('registers the background bash tool set for other models', async () => {
    const harness = createHarness();
    await backgroundBashExtension(harness.pi);

    await harness.emit('session_start', {}, context('anthropic'));

    expect(harness.registerTool.mock.calls.map(([tool]) => tool.name)).toEqual([
      'bash',
      'list_background_bash',
      'read_background_bash',
      'wait_background_bash',
      'stop_background_bash',
    ]);
    expect(harness.activeTools).toEqual([
      'bash',
      'list_background_bash',
      'read_background_bash',
      'wait_background_bash',
      'stop_background_bash',
    ]);
  });

  it('does not register tools when required POSIX process utilities are unavailable', async () => {
    const runtime = {
      ...unusedRuntime(),
      shell: vi.fn(async () => ({ stdout: '', stderr: 'sh: not found', code: 127, killed: false })),
    };
    const harness = createHarness(runtime);
    await backgroundBashExtension(harness.pi);

    await harness.emit('session_start', {}, context('anthropic'));

    expect(harness.registerTool).not.toHaveBeenCalled();
    expect(runtime.shell).toHaveBeenCalledOnce();
    expect(runtime.shell).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ shellFlavor: 'posix' }),
    );
  });

  it('activates when the selected model changes from OpenAI to another provider', async () => {
    const harness = createHarness();
    await backgroundBashExtension(harness.pi);
    await harness.emit('session_start', {}, context('openai-codex'));

    await harness.emit('model_select', { model: model('google') }, context('google'));

    expect(harness.registerTool).toHaveBeenCalledTimes(5);
  });

  it('restores foreground-only bash when the model changes to OpenAI', async () => {
    const harness = createHarness();
    await backgroundBashExtension(harness.pi);
    await harness.emit('session_start', {}, context('anthropic'));

    await harness.emit('model_select', { model: model('openai-codex') }, context('openai-codex'));

    expect(harness.activeTools).toEqual(['bash']);
    const restoredBash = harness.registerTool.mock.calls.at(-1)?.[0] as {
      name: string;
      parameters: { properties: Record<string, unknown> };
    };
    expect(restoredBash.name).toBe('bash');
    expect(restoredBash.parameters.properties).not.toHaveProperty('background');
  });

  it('converts foreground timeout seconds to runtime milliseconds', async () => {
    const shell = vi.fn(async (command: string) => command.includes('missing=')
      ? { stdout: '', stderr: '', code: 0, killed: false }
      : { stdout: '', stderr: '', code: 143, killed: true });
    const harness = createHarness({ ...unusedRuntime(), shell });
    await backgroundBashExtension(harness.pi);
    await harness.emit('session_start', {}, context('anthropic'));
    const bash = harness.registerTool.mock.calls[0]?.[0] as {
      execute: (
        id: string,
        params: { command: string; timeout: number },
        signal: AbortSignal | undefined,
        update: undefined,
        ctx: ExtensionContext,
      ) => Promise<unknown>;
    };

    await expect(bash.execute('call', { command: 'sleep 5', timeout: 2 }, undefined, undefined, context('anthropic')))
      .rejects.toThrow('Command timed out after 2 seconds');
    expect(shell).toHaveBeenCalledWith(
      'sleep 5',
      expect.objectContaining({ shellFlavor: 'posix', timeout: 2_000 }),
    );
  });

  it('steers terminal process completion into the parent session automatically', async () => {
    const running = backgroundJob('running');
    const completed = backgroundJob('completed');
    vi.spyOn(BackgroundBashManager.prototype, 'start').mockResolvedValue(running);
    vi.spyOn(BackgroundBashManager.prototype, 'get').mockResolvedValue(completed);
    const harness = createHarness();
    const ctx = context('anthropic');
    await backgroundBashExtension(harness.pi);
    await harness.emit('session_start', {}, ctx);
    const bash = registeredTool(harness, 'bash');

    try {
      const started = await bash.execute(
        'start',
        { command: "printf 'finished\\n'", background: true },
        undefined,
        undefined,
        ctx,
      ) as { details: { id: string } };

      await vi.waitFor(() => expect(harness.sendMessage).toHaveBeenCalledOnce());
      expect(harness.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          customType: 'felan-background-bash-completion',
          content: expect.stringContaining(started.details.id),
          display: true,
        }),
        { triggerTurn: true, deliverAs: 'steer' },
      );
      const message = harness.sendMessage.mock.calls[0]?.[0] as { details: unknown };
      expect(JSON.stringify(message.details)).not.toContain('processToken');
    } finally {
      await harness.emit('session_shutdown', {}, ctx);
    }
  });

  it('reads stored output without sending a second completion after wait finishes', async () => {
    const running = backgroundJob('running');
    const completed = backgroundJob('completed');
    let current = running;
    vi.spyOn(BackgroundBashManager.prototype, 'start').mockResolvedValue(running);
    vi.spyOn(BackgroundBashManager.prototype, 'get').mockImplementation(async () => current);
    vi.spyOn(BackgroundBashManager.prototype, 'wait').mockImplementation(async () => {
      current = completed;
      return { job: completed, timedOut: false };
    });
    vi.spyOn(BackgroundBashManager.prototype, 'tail').mockResolvedValue('stored output\n');
    const harness = createHarness();
    const ctx = context('anthropic');
    await backgroundBashExtension(harness.pi);
    await harness.emit('session_start', {}, ctx);
    const bash = registeredTool(harness, 'bash');
    const read = registeredTool(harness, 'read_background_bash');
    const wait = registeredTool(harness, 'wait_background_bash');
    try {
      const started = await bash.execute(
        'start',
        { command: "printf 'stored output\\n'; sleep 1", background: true },
        undefined,
        undefined,
        ctx,
      ) as { details: { id: string } };

      await wait.execute(
        'wait',
        { id: started.details.id, timeout: 5 },
        undefined,
        undefined,
        ctx,
      );
      const output = await read.execute(
        'read',
        { id: started.details.id, lines: 20 },
        undefined,
        undefined,
        ctx,
      ) as { content: Array<{ type: string; text: string }> };
      expect(output.content[0]?.text).toContain('stored output');
      await Promise.resolve();
      expect(harness.sendMessage).not.toHaveBeenCalled();
    } finally {
      await harness.emit('session_shutdown', {}, ctx);
    }
  });
});

function createHarness(runtime: AgentRuntime = unusedRuntime()) {
  const handlers = new Map<string, Handler[]>();
  const activeTools: string[] = [];
  const registerTool = vi.fn();
  const registerCommand = vi.fn();
  const registerShortcut = vi.fn();
  const sendMessage = vi.fn();
  const pi = {
    runtime,
    agentDir: '/agent',
    registerCapability: vi.fn(),
    registerTool,
    registerCommand,
    registerShortcut,
    sendMessage,
    getActiveTools: () => [...activeTools],
    setActiveTools: (names: string[]) => {
      activeTools.splice(0, activeTools.length, ...names);
    },
    on: (name: string, handler: Handler) => {
      const registered = handlers.get(name) ?? [];
      registered.push(handler);
      handlers.set(name, registered);
    },
  } as unknown as FelanExtensionAPI;

  return {
    pi,
    activeTools,
    registerTool,
    registerCommand,
    registerShortcut,
    sendMessage,
    async emit(name: string, event: unknown, ctx: ExtensionContext) {
      for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
    },
  };
}

function registeredTool(harness: ReturnType<typeof createHarness>, name: string) {
  const tool = harness.registerTool.mock.calls
    .map(([definition]) => definition)
    .find((definition) => definition.name === name);
  if (!tool) throw new Error(`Tool was not registered: ${name}`);
  return tool as {
    execute: (...args: any[]) => Promise<unknown>;
  };
}

function context(provider: string): ExtensionContext {
  return {
    mode: 'print',
    model: model(provider),
  } as unknown as ExtensionContext;
}

function model(provider: string): Model<Api> {
  return { provider } as Model<Api>;
}

function backgroundJob(status: BackgroundBashStatus): BackgroundBashJob {
  const id = 'bash-20260826000000-abcdef';
  const command = "printf 'finished\\n'";
  const cwd = '/workspace';
  const jobDir = '/storage/background-bash/workspace/jobs/bash-20260826000000-abcdef';
  const startedAt = Date.parse('2026-08-26T00:00:00.000Z');
  const updatedAt = startedAt + (status === 'running' ? 0 : 1_000);
  const terminal = status === 'running'
    ? {}
    : { exitCode: 0, signal: null, completedAt: updatedAt };
  const paths = {
    jobDir,
    logPath: `${jobDir}/output.log`,
    infoPath: `${jobDir}/info.json`,
    completionPath: `${jobDir}/completion.json`,
    commandPath: `${jobDir}/command.sh`,
    runnerPath: `${jobDir}/runner.sh`,
  };
  return {
    meta: {
      id,
      command,
      cwd,
      ...paths,
      shell: 'sh',
      shellArgs: [],
      startedAt,
      pid: 123,
      processGroupId: 123,
      processToken: 'private-process-token',
      creatorPid: 1,
    },
    status: {
      id,
      status,
      startedAt,
      updatedAt,
      pid: 123,
      ...terminal,
    },
    info: {
      id,
      command,
      cwd,
      ...paths,
      shell: 'sh',
      shellArgs: [],
      startedAt,
      updatedAt,
      status,
      pid: 123,
      processGroupId: 123,
      processToken: 'private-process-token',
      creatorPid: 1,
      ...terminal,
    },
  };
}

function unusedRuntime(): AgentRuntime {
  const unused = async (): Promise<never> => {
    throw new Error('Runtime operation was not expected');
  };
  return {
    kind: 'host',
    cwd: '/workspace',
    storage: () => ({
      root: '/storage',
      readFile: unused,
      writeFile: unused,
      listFiles: unused,
      mkdir: unused,
      remove: unused,
    }),
    exec: unused,
    shell: async () => ({ stdout: '', stderr: '', code: 0, killed: false }),
    readFile: unused,
    writeFile: unused,
    listFiles: unused,
    mkdir: unused,
    remove: unused,
  };
}
