import type {
  AgentRuntime,
  Api,
  ExtensionContext,
  FelanExtensionAPI,
  Model,
  Skill,
} from '@felan-ai/agent-core';
import { describe, expect, it, vi } from 'vitest';
import codexExtension, { CODEX_TOOL_MODE_EVENT } from '../src/index.js';

type Handler = (event: any, ctx: ExtensionContext) => unknown;

describe('Codex extension activation', () => {
  it('replaces only ordinary coding tools and preserves unrelated tools for eligible models', async () => {
    const harness = createHarness();
    await codexExtension(harness.pi);

    await harness.emit('session_start', {}, context('openai-codex', 'gpt-5.3-codex'));

    expect(harness.activeTools).toEqual([
      'grep', 'find', 'ls', 'ask_user', 'Agent', 'TaskCreate',
      'exec_command', 'write_stdin', 'apply_patch', 'view_image',
    ]);
    expect(harness.registerTool.mock.calls.map(([tool]) => tool.name)).toEqual([
      'exec_command', 'write_stdin', 'apply_patch', 'view_image',
    ]);
  });

  it('announces active Codex tool mode for eligible models', async () => {
    const harness = createHarness();
    await codexExtension(harness.pi);

    await harness.emit('session_start', {}, context('openai-codex', 'gpt-5.3-codex'));

    expect(harness.activeTools).not.toContain('read');
    expect(harness.toolModeEvents).toEqual([{ version: 1, active: true }]);
  });

  it('restores ordinary tools when switching away and activates on a later GPT selection', async () => {
    const harness = createHarness();
    await codexExtension(harness.pi);
    await harness.emit('session_start', {}, context('openai', 'gpt-5.4'));

    await harness.emit('model_select', { model: model('anthropic', 'claude-opus') }, context('anthropic', 'claude-opus'));
    expect(harness.activeTools).toEqual([
      'grep', 'find', 'ls', 'ask_user', 'Agent', 'TaskCreate',
      'read', 'bash', 'edit', 'write',
    ]);

    await harness.emit('model_select', { model: model('openai', 'gpt-5.4') }, context('openai', 'gpt-5.4'));
    expect(harness.activeTools).toContain('exec_command');
    expect(harness.activeTools).not.toContain('bash');
    expect(harness.toolModeEvents).toEqual([
      { version: 1, active: true },
      { version: 1, active: false },
      { version: 1, active: true },
    ]);
  });

  it('keeps ordinary tools for non-GPT OpenAI models', async () => {
    const harness = createHarness();
    await codexExtension(harness.pi);
    await harness.emit('session_start', {}, context('openai', 'o3'));

    expect(harness.activeTools).toEqual([
      'read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'ask_user', 'Agent', 'TaskCreate',
    ]);
    expect(harness.toolModeEvents).toEqual([{ version: 1, active: false }]);
  });

  it('keeps ordinary tools when the runtime lacks persistent-process support', async () => {
    const harness = createHarness(false);
    await codexExtension(harness.pi);
    await harness.emit('session_start', {}, context('openai-codex', 'gpt-5.3-codex'));

    expect(harness.activeTools).toEqual([
      'read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'ask_user', 'Agent', 'TaskCreate',
    ]);
    expect(harness.toolModeEvents).toEqual([{ version: 1, active: false }]);
  });

  it('activates view_image only for models with image input', async () => {
    const harness = createHarness();
    await codexExtension(harness.pi);
    await harness.emit('session_start', {}, {
      mode: 'print',
      model: { ...model('openai', 'gpt-5.4'), input: ['text'] },
    } as ExtensionContext);

    expect(harness.activeTools).not.toContain('view_image');
    expect(harness.activeTools).toEqual(expect.arrayContaining([
      'exec_command', 'write_stdin', 'apply_patch',
    ]));
  });

  it('preserves structured skills in the Codex prompt after replacing read', async () => {
    const harness = createHarness();
    const ctx = context('openai-codex', 'gpt-5.3-codex');
    await codexExtension(harness.pi);
    await harness.emit('session_start', {}, ctx);

    const [result] = await harness.emit('before_agent_start', {
      systemPrompt: 'Felan base prompt\nCurrent working directory: /workspace',
      systemPromptOptions: {
        cwd: '/workspace',
        skills: [
          skill('linear', 'Manage <Linear> issues', '/home/user/.agents/skills/linear/SKILL.md'),
          { ...skill('manual', 'Manual only', '/skills/manual/SKILL.md'), disableModelInvocation: true },
        ],
      },
    }, ctx);

    const systemPrompt = (result as { systemPrompt: string }).systemPrompt;
    expect(systemPrompt).toContain('<skills_instructions>');
    expect(systemPrompt).toContain('<name>linear</name>');
    expect(systemPrompt).toContain('<description>Manage &lt;Linear&gt; issues</description>');
    expect(systemPrompt).toContain('<location>/home/user/.agents/skills/linear/SKILL.md</location>');
    expect(systemPrompt).not.toContain('<name>manual</name>');
    expect(systemPrompt.indexOf('<skills_instructions>')).toBeLessThan(
      systemPrompt.indexOf('Current working directory:'),
    );
  });

  it('does not duplicate Pi skill guidance when ordinary tools remain active', async () => {
    const harness = createHarness(false);
    const ctx = context('openai-codex', 'gpt-5.3-codex');
    await codexExtension(harness.pi);
    await harness.emit('session_start', {}, ctx);
    const prompt = 'The following skills are available.\n<available_skills>...</available_skills>';

    const results = await harness.emit('before_agent_start', {
      systemPrompt: prompt,
      systemPromptOptions: {
        cwd: '/workspace',
        skills: [skill('linear', 'Manage Linear issues', '/skills/linear/SKILL.md')],
      },
    }, ctx);

    expect(results).toEqual([undefined]);
  });

  it('does not register or unregister shared providers', async () => {
    const harness = createHarness();
    await codexExtension(harness.pi);
    expect(harness.registerProvider).not.toHaveBeenCalled();

    await harness.emit('session_shutdown', {}, context('openai', 'gpt-5.4'));

    expect(harness.unregisterProvider).not.toHaveBeenCalled();
  });

  it('defers eligible threshold compaction until the agent settles by default', async () => {
    const harness = createHarness();
    await codexExtension(harness.pi);
    const ctx = context('openai-codex', 'gpt-5.3-codex');
    const compact = vi.fn();
    ctx.isIdle = () => false;
    ctx.compact = compact;

    await expect(harness.emit('session_before_compact', { reason: 'threshold' }, ctx))
      .resolves.toEqual([{ cancel: true }]);
    await harness.emit('agent_settled', {}, ctx);

    expect(compact).toHaveBeenCalledTimes(1);
  });

  it('schedules at most one post-agent compaction per agent run', async () => {
    const harness = createHarness();
    await codexExtension(harness.pi);
    const ctx = context('openai-codex', 'gpt-5.3-codex');
    ctx.isIdle = () => false;

    await harness.emit('agent_start', {}, ctx);
    await harness.emit('session_before_compact', { reason: 'threshold' }, ctx);
    await harness.emit('agent_settled', {}, ctx);
    const options = vi.mocked(ctx.compact).mock.calls[0]![0]!;

    await expect(harness.emit('session_before_compact', { reason: 'threshold' }, ctx))
      .resolves.toEqual([{ cancel: true }]);
    options.onComplete?.({} as never);
    await expect(harness.emit('session_before_compact', { reason: 'threshold' }, ctx))
      .resolves.toEqual([{ cancel: true }]);
    await harness.emit('agent_settled', {}, ctx);

    expect(ctx.compact).toHaveBeenCalledTimes(1);

    await harness.emit('agent_start', {}, ctx);
    await harness.emit('session_before_compact', { reason: 'threshold' }, ctx);
    await harness.emit('agent_settled', {}, ctx);

    expect(ctx.compact).toHaveBeenCalledTimes(2);
  });

  it('does not report user-aborted post-agent compaction as a failure', async () => {
    const harness = createHarness();
    await codexExtension(harness.pi);
    const ctx = context('openai', 'gpt-5.4');
    const notify = vi.fn();
    ctx.isIdle = () => false;
    ctx.ui = { notify } as never;

    await harness.emit('session_before_compact', { reason: 'threshold' }, ctx);
    await harness.emit('agent_settled', {}, ctx);
    const options = vi.mocked(ctx.compact).mock.calls[0]![0]!;
    options.onError?.(new Error('Turn prefix summarization failed: This operation was aborted'));
    await harness.emit('session_before_compact', { reason: 'threshold' }, ctx);
    await harness.emit('agent_settled', {}, ctx);

    expect(notify).not.toHaveBeenCalled();
    expect(ctx.compact).toHaveBeenCalledTimes(1);
  });

  it('does not follow a completed immediate compaction with post-agent compaction', async () => {
    const harness = createHarness();
    await codexExtension(harness.pi);
    const ctx = context('openai', 'gpt-5.4');
    ctx.isIdle = () => false;

    await harness.emit('agent_start', {}, ctx);
    await harness.emit('session_before_compact', { reason: 'threshold' }, ctx);
    await harness.emit('session_before_compact', { reason: 'overflow' }, ctx);
    const compactionEntry = persistCompaction(ctx, 'immediate-compaction');
    await harness.emit('session_compact', {
      reason: 'overflow',
      compactionEntry,
    }, ctx);
    await harness.emit('session_before_compact', { reason: 'threshold' }, ctx);
    await harness.emit('agent_settled', {}, ctx);

    expect(ctx.compact).not.toHaveBeenCalled();
  });

  it.each(['manual', 'overflow'] as const)(
    'lets %s compaction supersede a deferred threshold without another post-agent compaction',
    async (reason) => {
      const harness = createHarness();
      await codexExtension(harness.pi);
      const ctx = context('openai', 'gpt-5.4');
      ctx.isIdle = () => false;

      await harness.emit('session_before_compact', { reason: 'threshold' }, ctx);
      await expect(harness.emit('session_before_compact', { reason }, ctx))
        .resolves.toEqual([undefined]);
      await harness.emit('agent_settled', {}, ctx);

      expect(ctx.compact).not.toHaveBeenCalled();
    },
  );

  it('ignores completion callbacks from a replaced session', async () => {
    const harness = createHarness();
    await codexExtension(harness.pi);
    const ctx = context('openai', 'gpt-5.4');
    ctx.isIdle = () => false;

    await harness.emit('session_before_compact', { reason: 'threshold' }, ctx);
    await harness.emit('agent_settled', {}, ctx);
    const previousOptions = vi.mocked(ctx.compact).mock.calls[0]![0]!;

    await harness.emit('session_start', {}, ctx);
    await harness.emit('session_before_compact', { reason: 'threshold' }, ctx);
    await harness.emit('agent_settled', {}, ctx);
    const currentOptions = vi.mocked(ctx.compact).mock.calls[1]![0]!;
    previousOptions.onComplete?.({} as never);

    await expect(harness.emit('session_before_compact', { reason: 'threshold' }, ctx))
      .resolves.toEqual([{ cancel: true }]);
    currentOptions.onComplete?.({} as never);
    await harness.emit('agent_settled', {}, ctx);

    expect(ctx.compact).toHaveBeenCalledTimes(2);
  });

  it.each(['onComplete', 'onError'] as const)(
    'ignores %s callbacks after session shutdown invalidates the context',
    async (callback) => {
      const harness = createHarness();
      await codexExtension(harness.pi);
      const ctx = context('openai', 'gpt-5.4');
      let contextActive = true;
      ctx.isIdle = () => {
        if (!contextActive) {
          throw new Error('This extension ctx is stale after session replacement or reload.');
        }
        return false;
      };

      await harness.emit('session_before_compact', { reason: 'threshold' }, ctx);
      await harness.emit('agent_settled', {}, ctx);
      const options = vi.mocked(ctx.compact).mock.calls[0]![0]!;

      await harness.emit('session_shutdown', { reason: 'resume' }, ctx);
      contextActive = false;

      expect(() => {
        if (callback === 'onComplete') options.onComplete?.({} as never);
        else options.onError?.(new Error('Compaction cancelled'));
      }).not.toThrow();
    },
  );

  it('ignores a successful compaction event from a replaced session', async () => {
    const harness = createHarness();
    await codexExtension(harness.pi);
    const previousCtx = context('openai', 'gpt-5.4');
    const currentCtx = context('openai', 'gpt-5.4');
    previousCtx.isIdle = () => false;
    currentCtx.isIdle = () => false;

    await harness.emit('session_before_compact', {
      reason: 'overflow',
      branchEntries: [{ id: 'previous-leaf' }],
    }, previousCtx);
    await harness.emit('session_start', {}, currentCtx);
    await harness.emit('agent_start', {}, currentCtx);
    await harness.emit('session_before_compact', {
      reason: 'overflow',
      branchEntries: [{ id: 'current-leaf' }],
    }, currentCtx);
    await harness.emit('session_compact', {
      reason: 'overflow',
      compactionEntry: { id: 'previous-compaction', parentId: 'previous-leaf' },
    }, currentCtx);
    const currentEntry = persistCompaction(currentCtx, 'current-compaction', 'current-leaf');
    await harness.emit('session_compact', {
      reason: 'overflow',
      compactionEntry: currentEntry,
    }, currentCtx);
    await harness.emit('session_before_compact', { reason: 'threshold' }, currentCtx);
    await harness.emit('agent_settled', {}, currentCtx);

    expect(currentCtx.compact).not.toHaveBeenCalled();
  });

  it('recognizes a successful compaction after its branch advances', async () => {
    const harness = createHarness();
    await codexExtension(harness.pi);
    const ctx = context('openai', 'gpt-5.4');
    ctx.isIdle = () => false;

    await harness.emit('agent_start', {}, ctx);
    await harness.emit('session_before_compact', {
      reason: 'overflow',
      branchEntries: [{ id: 'initial-leaf' }],
    }, ctx);
    const compactionEntry = persistCompaction(ctx, 'advanced-compaction', 'new-custom-entry');
    await harness.emit('session_compact', {
      reason: 'overflow',
      compactionEntry,
    }, ctx);
    await harness.emit('session_before_compact', { reason: 'threshold' }, ctx);
    await harness.emit('agent_settled', {}, ctx);

    expect(ctx.compact).not.toHaveBeenCalled();
  });

  it('supersedes stale Pi compaction attribution after a failure', async () => {
    const harness = createHarness();
    await codexExtension(harness.pi);
    const ctx = context('openai', 'gpt-5.4');
    ctx.isIdle = () => false;

    await harness.emit('agent_start', {}, ctx);
    await harness.emit('session_before_compact', {
      reason: 'overflow',
      branchEntries: [{ id: 'failed-leaf' }],
    }, ctx);
    await harness.emit('session_compact_failed', { reason: 'overflow' }, ctx);
    await harness.emit('session_before_compact', {
      reason: 'overflow',
      branchEntries: [{ id: 'current-leaf' }],
    }, ctx);
    const compactionEntry = persistCompaction(ctx, 'current-compaction', 'current-leaf');
    await harness.emit('session_compact', {
      reason: 'overflow',
      compactionEntry,
    }, ctx);
    await harness.emit('session_before_compact', {
      reason: 'threshold',
      branchEntries: [{ id: 'current-leaf' }],
    }, ctx);
    await harness.emit('agent_settled', {}, ctx);

    expect(ctx.compact).not.toHaveBeenCalled();
  });

  it('preserves a queued run compaction request until the previous compaction completes', async () => {
    const harness = createHarness();
    await codexExtension(harness.pi);
    const ctx = context('openai', 'gpt-5.4');
    let idle = false;
    ctx.isIdle = () => idle;

    await harness.emit('agent_start', {}, ctx);
    await harness.emit('session_before_compact', { reason: 'threshold' }, ctx);
    await harness.emit('agent_settled', {}, ctx);
    const previousOptions = vi.mocked(ctx.compact).mock.calls[0]![0]!;
    await harness.emit('session_before_compact', {
      reason: 'manual',
      branchEntries: [{ id: 'previous-leaf' }],
    }, ctx);

    await harness.emit('agent_start', {}, ctx);
    await harness.emit('session_before_compact', { reason: 'threshold' }, ctx);
    await harness.emit('agent_settled', {}, ctx);
    expect(ctx.compact).toHaveBeenCalledTimes(1);

    const compactionEntry = persistCompaction(ctx, 'previous-compaction', 'previous-leaf');
    await harness.emit('session_compact', {
      reason: 'manual',
      compactionEntry,
    }, ctx);
    idle = true;
    previousOptions.onComplete?.({} as never);

    expect(ctx.compact).toHaveBeenCalledTimes(2);
  });

  it('keeps Pi threshold timing when post-agent compaction is disabled', async () => {
    const harness = createHarness(true, { postAgentRunCompaction: false });
    await codexExtension(harness.pi);
    const ctx = context('openai-codex', 'gpt-5.3-codex');
    ctx.isIdle = () => false;

    await expect(harness.emit('session_before_compact', { reason: 'threshold' }, ctx))
      .resolves.toEqual([undefined]);
    await harness.emit('agent_settled', {}, ctx);

    expect(ctx.compact).not.toHaveBeenCalled();
  });

  it('does not defer threshold compaction for non-GPT models', async () => {
    const harness = createHarness();
    await codexExtension(harness.pi);
    const ctx = context('openai', 'o3');
    ctx.isIdle = () => false;

    await expect(harness.emit('session_before_compact', { reason: 'threshold' }, ctx))
      .resolves.toEqual([undefined]);
  });

  it('does not defer manual or overflow compaction', async () => {
    const harness = createHarness();
    await codexExtension(harness.pi);
    const ctx = context('openai', 'gpt-5.4');
    ctx.isIdle = () => false;

    await expect(harness.emit('session_before_compact', { reason: 'manual' }, ctx))
      .resolves.toEqual([undefined]);
    await expect(harness.emit('session_before_compact', { reason: 'overflow' }, ctx))
      .resolves.toEqual([undefined]);
  });

  it('clears deferred state if the model changes before settlement', async () => {
    const harness = createHarness();
    await codexExtension(harness.pi);
    const gpt = context('openai', 'gpt-5.4');
    gpt.isIdle = () => false;
    await harness.emit('session_before_compact', { reason: 'threshold' }, gpt);

    const other = context('anthropic', 'claude-opus');
    await harness.emit('agent_settled', {}, other);
    await harness.emit('agent_settled', {}, gpt);

    expect(gpt.compact).not.toHaveBeenCalled();
  });
});

function createHarness(processSupport = true, config: Record<string, unknown> = {}) {
  const handlers = new Map<string, Handler[]>();
  const activeTools = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'ask_user', 'Agent', 'TaskCreate'];
  const registerTool = vi.fn();
  const registerProvider = vi.fn();
  const unregisterProvider = vi.fn();
  const toolModeEvents: Array<{ version: number; active: boolean }> = [];
  const pi = {
    runtime: unusedRuntime(processSupport),
    agentDir: '/agent',
    config,
    registerCapability: vi.fn(),
    registerTool,
    registerProvider,
    unregisterProvider,
    events: {
      emit: (channel: string, data: unknown) => {
        if (channel === CODEX_TOOL_MODE_EVENT) {
          toolModeEvents.push(data as { version: number; active: boolean });
        }
      },
    },
    getActiveTools: () => [...activeTools],
    setActiveTools: (names: string[]) => activeTools.splice(0, activeTools.length, ...names),
    on: (name: string, handler: Handler) => {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
  } as unknown as FelanExtensionAPI;
  return {
    pi,
    activeTools,
    registerTool,
    registerProvider,
    unregisterProvider,
    toolModeEvents,
    async emit(name: string, event: unknown, ctx: ExtensionContext) {
      const results: unknown[] = [];
      for (const handler of handlers.get(name) ?? []) results.push(await handler(event, ctx));
      return results;
    },
  };
}

function context(provider: string, id: string): ExtensionContext {
  const entries = new Map<string, unknown>();
  const ctx = {
    mode: 'print',
    model: model(provider, id),
    isIdle: () => true,
    compact: vi.fn(),
    sessionManager: { getEntry: (entryId: string) => entries.get(entryId) },
  } as unknown as ExtensionContext;
  sessionEntries.set(ctx, entries);
  return ctx;
}

const sessionEntries = new WeakMap<ExtensionContext, Map<string, unknown>>();

function persistCompaction(ctx: ExtensionContext, id: string, parentId?: string): Record<string, unknown> {
  const entry = { type: 'compaction', id, parentId };
  sessionEntries.get(ctx)?.set(id, entry);
  return entry;
}

function model(provider: string, id: string): Model<Api> {
  return { provider, id, api: 'openai-responses', input: ['text', 'image'] } as Model<Api>;
}

function skill(name: string, description: string, filePath: string): Skill {
  return {
    name,
    description,
    filePath,
    baseDir: filePath.replace(/\/SKILL\.md$/u, ''),
    sourceInfo: {
      path: filePath,
      source: 'local',
      scope: 'user',
      origin: 'top-level',
    },
    disableModelInvocation: false,
  };
}

function unusedRuntime(processSupport: boolean): AgentRuntime {
  const unused = async (): Promise<never> => { throw new Error('unused'); };
  return {
    kind: 'host',
    cwd: '/workspace',
    ...(processSupport ? { processes: { startShell: unused } } : {}),
    storage: () => ({ root: '/storage', readFile: unused, writeFile: unused, listFiles: unused, mkdir: unused, remove: unused }),
    exec: unused,
    shell: unused,
    readFile: unused,
    writeFile: unused,
    listFiles: unused,
    mkdir: unused,
    remove: unused,
  };
}
