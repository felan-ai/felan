import {
  type AgentRuntime,
  type Api,
  type ExtensionContext,
  type FelanExtensionAPI,
  type Model,
} from '@felan-ai/agent-core';
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import { afterEach, describe, expect, it, vi } from 'vitest';
import backgroundBashExtension, {
  BackgroundBashManager,
  type BackgroundBashJob,
  type BackgroundBashStatus,
} from '../src/index.js';
import { BackgroundBashView } from '../src/ui/background-bash-view.js';

type Handler = (event: any, ctx: ExtensionContext) => unknown;
type CompletionRenderer = (
  message: any,
  options: { expanded: boolean; outputPad: number },
  theme: any,
) => { render(width: number): string[] } | undefined;

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('background bash extension activation', () => {
  it('renders an inline frame for an empty process list', async () => {
    const view = new BackgroundBashView(
      { list: vi.fn(async () => []) } as unknown as BackgroundBashManager,
      theme as never,
      vi.fn(),
      vi.fn(),
    );
    await Promise.resolve();
    const lines = view.render(50);
    expect(lines[0]).toBe('─'.repeat(50));
    expect(lines.at(-1)).toBe('─'.repeat(50));
    expect(lines.slice(1, -1).every((line) => !line.startsWith('│') && !line.endsWith('│'))).toBe(true);
    expect(lines.every((line) => visibleWidth(line) <= 50)).toBe(true);
    for (let width = 0; width <= 5; width += 1) {
      expect(view.render(width).every((line) => visibleWidth(line) <= Math.max(1, width))).toBe(true);
    }
  });

  it('sanitizes commands and logs before rendering them', async () => {
    const job = backgroundJob('running');
    job.meta.command = '\u001b]0;owned\u0007\u001b[31msleep\u001b[0m\u0008 30';
    const view = new BackgroundBashView(
      {
        list: vi.fn(async () => [job]),
        tail: vi.fn(async () => '--- output ---\n\u001b]0;owned\u0007\u001b[31mlog line\u001b[0m\u0008'),
      } as unknown as BackgroundBashManager,
      theme as never,
      vi.fn(),
      vi.fn(),
    );
    await Promise.resolve();

    const listLines = view.render(100);
    const listOutput = listLines.join('\n');
    expect(listOutput).toContain('sleep 30');
    expect(listOutput).not.toContain('owned');
    expect(listLines.every((line) => (
      !/[\u0000-\u001F\u007F-\u009F]/u.test(stripTerminalSequences(line))
    ))).toBe(true);

    view.handleInput('\r');
    await Promise.resolve();
    const detailLines = view.render(100);
    const detailOutput = detailLines.join('\n');
    expect(detailOutput).toContain('log line');
    expect(detailOutput).not.toContain('owned');
    expect(detailLines.every((line) => (
      !/[\u0000-\u001F\u007F-\u009F]/u.test(stripTerminalSequences(line))
    ))).toBe(true);
  });

  it('does not request a late render after closing during refresh', async () => {
    let resolveList!: (jobs: BackgroundBashJob[]) => void;
    const requestRender = vi.fn();
    const done = vi.fn();
    const view = new BackgroundBashView(
      {
        list: vi.fn(() => new Promise<BackgroundBashJob[]>((resolve) => {
          resolveList = resolve;
        })),
      } as unknown as BackgroundBashManager,
      theme as never,
      done,
      requestRender,
    );
    requestRender.mockClear();

    view.handleInput('q');
    resolveList([]);
    await Promise.resolve();
    await Promise.resolve();

    expect(done).toHaveBeenCalledOnce();
    expect(requestRender).not.toHaveBeenCalled();
  });

  it('opens the process view inline', async () => {
    vi.spyOn(BackgroundBashManager.prototype, 'list').mockResolvedValue([]);
    const harness = createHarness();
    const ctx = tuiContext('anthropic');
    await backgroundBashExtension(harness.pi);
    await harness.emit('session_start', {}, ctx);

    try {
      const command = harness.registerCommand.mock.calls
        .find(([name]) => name === 'background-bash')?.[1] as {
          handler: (args: string, context: ExtensionContext) => Promise<void>;
        };
      await command.handler('', ctx);

      expect(ctx.ui.custom).toHaveBeenCalledOnce();
      expect((ctx.ui.custom as any).mock.calls[0]).toHaveLength(1);
    } finally {
      await harness.emit('session_shutdown', {}, ctx);
    }
  });

  it('registers TUI controls before switching away from an OpenAI model', async () => {
    vi.spyOn(BackgroundBashManager.prototype, 'list').mockResolvedValue([]);
    const harness = createHarness();
    const openaiContext = tuiContext('openai');
    const anthropicContext = tuiContext('anthropic');
    await backgroundBashExtension(harness.pi);
    await harness.emit('session_start', {}, openaiContext);

    expect(harness.registerTool).not.toHaveBeenCalled();
    expect(harness.registerCommand).toHaveBeenCalledWith(
      'background-bash',
      expect.any(Object),
    );
    expect(harness.registerShortcut).toHaveBeenCalledOnce();

    try {
      await harness.emit(
        'model_select',
        { model: model('anthropic') },
        anthropicContext,
      );
      const command = harness.registerCommand.mock.calls
        .find(([name]) => name === 'background-bash')?.[1] as {
          handler: (args: string, context: ExtensionContext) => Promise<void>;
        };
      await command.handler('', anthropicContext);

      expect(harness.registerTool).toHaveBeenCalledTimes(5);
      expect(anthropicContext.ui.custom).toHaveBeenCalledOnce();
    } finally {
      await harness.emit('session_shutdown', {}, anthropicContext);
    }
  });

  it('renders completion messages as a bounded summary with optional details', async () => {
    const harness = createHarness();
    await backgroundBashExtension(harness.pi);
    const renderer = harness.messageRenderers.get('felan-background-bash-completion')!;
    const id = 'bash-20260904074143-fbba66';
    const message = {
      role: 'custom',
      customType: 'felan-background-bash-completion',
      content: '[felan-background-bash-completion]\n\nBackground Bash process reached terminal status: killed.\n\nPID: 50568',
      display: true,
      details: {
        job: {
          id,
          status: 'killed',
          command: '\u001b[31msleep 30\u0007\u0008\u001b[0m',
          signal: 'SIGTERM',
        },
      },
      timestamp: 1,
    };

    const collapsed = renderer(message, { expanded: false, outputPad: 1 }, theme)!.render(60);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]).toContain('Background Bash killed');
    expect(collapsed[0]).toContain('fbba66');
    expect(collapsed.join('\n')).not.toContain('[felan-background-bash-completion]');
    expect(collapsed.join('\n')).not.toContain('PID: 50568');
    expect(collapsed.join('\n')).not.toMatch(/[\u0007\u0008\u009B]/u);
    expect(collapsed.every((line) => visibleWidth(line) <= 60)).toBe(true);

    const expanded = renderer(message, { expanded: true, outputPad: 1 }, theme)!.render(60);
    expect(expanded.join('\n')).toContain(id);
    expect(expanded.join('\n')).toContain('signal SIGTERM');
    expect(expanded.join('\n')).toContain('read_background_bash');
    expect(expanded.every((line) => visibleWidth(line) <= 60)).toBe(true);

    const fallback = renderer(
      { ...message, details: undefined, content: 'one\ntwo\nthree\nfour\nfive' },
      { expanded: true, outputPad: 1 },
      theme,
    )!.render(60);
    expect(fallback.join('\n')).toContain('2 more lines');
  });

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
    const ctx = tuiContext('anthropic');
    await backgroundBashExtension(harness.pi);

    await harness.emit('session_start', {}, ctx);

    expect(harness.registerTool).not.toHaveBeenCalled();
    expect(runtime.shell).toHaveBeenCalledOnce();
    expect(runtime.shell).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ shellFlavor: 'posix' }),
    );
    const command = harness.registerCommand.mock.calls
      .find(([name]) => name === 'background-bash')?.[1] as {
        handler: (args: string, context: ExtensionContext) => Promise<void>;
      };
    await command.handler('', ctx);
    expect(ctx.ui.custom).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      'Background Bash is unavailable in this runtime.',
      'info',
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
  const messageRenderers = new Map<string, CompletionRenderer>();
  const registerTool = vi.fn();
  const registerCommand = vi.fn();
  const registerMessageRenderer = vi.fn((name: string, renderer: CompletionRenderer) => {
    messageRenderers.set(name, renderer);
  });
  const registerShortcut = vi.fn();
  const sendMessage = vi.fn();
  const pi = {
    runtime,
    agentDir: '/agent',
    registerCapability: vi.fn(),
    registerTool,
    registerCommand,
    registerMessageRenderer,
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
    messageRenderers,
    registerTool,
    registerCommand,
    registerMessageRenderer,
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

function tuiContext(provider: string): ExtensionContext {
  return {
    mode: 'tui',
    model: model(provider),
    ui: {
      custom: vi.fn(async () => undefined),
      notify: vi.fn(),
      setStatus: vi.fn(),
      theme,
    },
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
