import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as core from '@felan-ai/agent-core';
import {
  HostAgentRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentCoreSession,
  createAssistantMessageEventStream,
  getCurrentTools,
  type AgentSession,
  type AssistantMessage,
  type InlineExtension,
  type StreamFunction,
} from '@felan-ai/agent-core';
import { Type } from 'typebox';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalCodemodeExtension } from '../src/codemode.js';
import { builtinExtensionPackages } from '../src/extensions.js';
import { createLocalFelanRuntime } from '../src/runtime.js';
import type { LocalCodemodeMode } from '../src/settings.js';
import { inspectionToolNames } from '../src/subagents/host.js';

const temporaryPaths: string[] = [];
const cleanup: (() => void | Promise<void>)[] = [];
const codingTools = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'];
type OfflineContext = Parameters<ModelRuntime['streamSimple']>[1];

afterEach(async () => {
  try {
    for (const dispose of cleanup.splice(0).reverse()) await dispose();
  } finally {
    vi.restoreAllMocks();
    await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
  }
});

describe('local codemode composition', () => {
  it('does not construct an extension when disabled', () => {
    expect(createLocalCodemodeExtension('off')).toBeUndefined();
  });

  it.each([undefined, 'off', 'on', 'only'] as const)(
    'uses settings mode %s in the actual root runtime and model-facing loadout',
    async (mode) => {
      const fixture = await harness(mode);
      const contexts = fixture.respond();
      const runtime = await fixture.rootRuntime();
      await runtime.session.bindExtensions({ mode: 'print' });
      await runtime.session.prompt('Inspect without contacting a provider');

      const enabled = mode === 'on' || mode === 'only';
      const expected = [...codingTools, ...(enabled ? ['codemode'] : [])];
      expect(runtime.session.getActiveToolNames().sort()).toEqual(expected.sort());
      expect(runtime.session.agent.state.tools.map((tool) => tool.name).sort()).toEqual(expected.sort());
      expect(contexts).toHaveLength(1);
      expect(declaredNames(contexts[0]!)).toEqual(mode === 'only' ? ['codemode'] : expected.sort());
      const extensions = runtime.session.resourceLoader.getExtensions().extensions;
      expect(extensions.filter((extension) => extension.path === '<inline:@felan-ai/felan/codemode>'))
        .toHaveLength(enabled ? 1 : 0);
      expect(extensions.some((extension) => extension.path.startsWith('<inline:@felan-ai/ext-'))).toBe(false);
      if (enabled) {
        const declaration = getCurrentTools(contexts[0]!.messages).find((tool) => tool.name === 'codemode')!;
        expect(declaration.description).not.toContain('Model API:');
        expect(declaration.description).not.toContain('models.classify');
        if (mode === 'only') expect(declaration.description).toContain('### `read`');
        if (mode === 'on') {
          const read = getCurrentTools(contexts[0]!.messages).find((tool) => tool.name === 'read')!;
          expect(read.description).toContain('tools.read(args)');
          expect(read.description).toContain('resolves to `string | { data: string;');
          expect(read.description).toContain('type: "image"');
        }
      }
    },
  );

  it.each(['off', 'on', 'only'] as const)('recomposes a resumed root using current mode %s', async (mode) => {
    const fixture = await harness('off');
    const contexts = fixture.respond();
    const initial = await fixture.rootRuntime();
    await initial.session.bindExtensions({ mode: 'print' });
    await initial.session.prompt('Persist this offline session');
    const sessionFile = initial.session.sessionFile!;
    const sessionId = initial.session.sessionId;
    await fixture.settings(mode);
    await initial.dispose();

    const resumed = await fixture.rootRuntime(SessionManager.open(sessionFile));
    await resumed.session.bindExtensions({ mode: 'print' });
    await resumed.session.prompt('Resume this offline session');

    expect(resumed.session.sessionId).toBe(sessionId);
    expect(resumed.session.messages.some((message) => message.role === 'user'
      && textContent(message.content).includes('Persist this offline session'))).toBe(true);
    expect(declaredNames(contexts.at(-1)!)).toEqual(mode === 'only'
      ? ['codemode'] : [...codingTools, ...(mode === 'on' ? ['codemode'] : [])].sort());
    expect(resumed.session.getActiveToolNames().filter((name) => name === 'codemode'))
      .toHaveLength(mode === 'off' ? 0 : 1);
  });

  it.each(['off', 'on', 'only'] as const)('inherits the root mode %s through the real child host', async (mode) => {
    const fixture = await harness(mode);
    const contexts = fixture.respond();
    const runtime = await fixture.rootRuntime();
    await runtime.session.bindExtensions({ mode: 'print' });
    const createChild = vi.spyOn(core, 'createAgentCoreSession');
    const spawned = await runtime.localSubagentHost.spawn({
      type: 'general', description: 'Offline inheritance', prompt: 'Report inherited tools',
      model: `${fixture.model.provider}/${fixture.model.id}`,
    });
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) throw new Error(spawned.error.message);
    await vi.waitFor(async () => {
      expect(await runtime.localSubagentHost.getResult(spawned.value.agentId))
        .toMatchObject({ ok: true, value: { status: 'completed', result: 'Done' } });
    });

    expect(createChild).toHaveBeenCalledOnce();
    const extensions = createChild.mock.calls[0]![0].inlineExtensions ?? [];
    expect(extensions.filter((extension) => typeof extension !== 'function'
      && extension.name === '@felan-ai/felan/codemode')).toHaveLength(mode === 'off' ? 0 : 1);
    expect(contexts.length).toBeGreaterThanOrEqual(1);
    for (const context of contexts) {
      expect(declaredNames(context)).toEqual(mode === 'only'
        ? ['codemode'] : [...codingTools, ...(mode === 'on' ? ['codemode'] : [])].sort());
    }
  });

  it('snapshots the root and child mode until the next runtime composition', async () => {
    const fixture = await harness('on');
    const contexts = fixture.respond();
    const runtime = await fixture.rootRuntime();
    await runtime.session.bindExtensions({ mode: 'print' });
    await fixture.settings('only');
    await runtime.session.settingsManager.reload();
    await runtime.session.prompt('Keep the original mode');
    const spawned = await runtime.localSubagentHost.spawn({
      type: 'general', description: 'Snapshot', prompt: 'Keep the original mode',
      model: `${fixture.model.provider}/${fixture.model.id}`,
    });
    if (!spawned.ok) throw new Error(spawned.error.message);
    await vi.waitFor(async () => expect(await runtime.localSubagentHost.getResult(spawned.value.agentId))
      .toMatchObject({ ok: true, value: { status: 'completed' } }));
    expect(contexts.length).toBeGreaterThanOrEqual(2);
    for (const context of contexts) expect(declaredNames(context)).toEqual([...codingTools, 'codemode'].sort());

    const replacement = await fixture.rootRuntime();
    await replacement.session.bindExtensions({ mode: 'print' });
    await replacement.session.prompt('Use the newly configured mode');
    expect(declaredNames(contexts.at(-1)!)).toEqual(['codemode']);
  });
});

describe('native codemode offline execution', () => {
  it('keeps model-only tools directly declared but unavailable to scripts in only mode', async () => {
    const fixture = await harness('only');
    const contexts = fixture.respond();
    const session = await fixture.nativeSession('only', [{
      name: 'offline-model-only', factory: (pi) => pi.registerTool({
        name: 'model_only_fixture', label: 'Model only', description: 'Direct-only fixture',
        exposure: 'model-only', parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: 'text', text: 'Done' }], details: {} }),
      }),
    }]);
    await session.prompt('Inspect declarations');
    expect(declaredNames(contexts[0]!)).toEqual(['codemode', 'model_only_fixture']);
    expect(session.getCallableToolNames()).not.toContain('model_only_fixture');
  });

  it('runs nested calls through blocking/result hooks and retains an audit without leaking nested output', async () => {
    const fixture = await harness('only');
    const structured = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'PRIVATE nested text' }],
      structuredContent: { count: 7 }, details: {},
    }));
    const blocked = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'must not run' }], details: {} }));
    const calls: { toolName: string; toolCallId: string; parentToolCallId?: string }[] = [];
    const results: { toolName: string; toolCallId: string; parentToolCallId?: string; isError: boolean }[] = [];
    const extension: InlineExtension = {
      name: 'offline-audit', factory: (pi) => {
        pi.registerTool({
          name: 'structured', label: 'structured', description: 'Count fixture', parameters: Type.Object({}),
          outputSchema: Type.Object({ count: Type.Number() }), execute: structured,
        });
        pi.registerTool({
          name: 'blocked', label: 'blocked', description: 'Blocked fixture', parameters: Type.Object({}), execute: blocked,
        });
        pi.on('tool_call', (event) => {
          calls.push(event);
          if (event.toolName === 'blocked') return { block: true, reason: 'Offline policy denied' };
        });
        pi.on('tool_result', (event) => {
          results.push(event);
          if (event.toolName === 'structured') return { structuredContent: { count: 9 } };
        });
      },
    };
    const contexts = fixture.respond(`
      const value = await tools.structured({});
      text({ count: value.count, type: typeof value });
      try { await tools.blocked({}); } catch (error) { text(error.message); }
    `);
    const session = await fixture.nativeSession('only', [extension]);
    await session.prompt('Run the audited script');

    expect(structured).toHaveBeenCalledOnce();
    expect(blocked).not.toHaveBeenCalled();
    expect(calls).toMatchObject([
      { toolName: 'codemode', toolCallId: 'script-1' },
      { toolName: 'structured', toolCallId: 'script-1/1', parentToolCallId: 'script-1' },
      { toolName: 'blocked', toolCallId: 'script-1/2', parentToolCallId: 'script-1' },
    ]);
    expect(results).toContainEqual(expect.objectContaining({
      toolName: 'structured', parentToolCallId: 'script-1', isError: false,
    }));
    const result = scriptResult(session);
    expect(result.isError).toBe(false);
    expect(textContent(result.content)).toContain('{"count":9,"type":"object"}');
    expect(textContent(result.content)).toContain('Offline policy denied');
    expect(result.nestedCalls).toMatchObject({ complete: true, calls: [
      { id: 'script-1/1', name: 'structured', status: 'ok', arguments: {} },
      { id: 'script-1/2', name: 'blocked', status: 'error', error: 'Offline policy denied' },
    ] });
    expect(session.sessionManager.getEntries()).toContainEqual(expect.objectContaining({ type: 'message', message: result }));
    expect(session.messages.filter((message) => message.role === 'toolResult')).toHaveLength(1);
    expect(contexts).toHaveLength(2);
    expect(JSON.stringify(contexts[1]!.messages)).not.toContain('PRIVATE nested text');
  });

  it('returns plain nested text when a tool has no output schema', async () => {
    const fixture = await harness('on');
    const execute = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'plain output' }], structuredContent: { count: 7 }, details: {},
    }));
    fixture.respond('const value = await tools.plain({}); return { value, type: typeof value };');
    const session = await fixture.nativeSession('on', [{
      name: 'offline-plain', factory: (pi) => pi.registerTool({
        name: 'plain', label: 'plain', description: 'Plain fixture', parameters: Type.Object({}), execute,
      }),
    }]);
    await session.prompt('Run the plain script');
    expect(textContent(scriptResult(session).content)).toContain('{"value":"plain output","type":"string"}');
    expect(execute).toHaveBeenCalledOnce();
  });

  it('separates multiple text items from captured console output', async () => {
    const fixture = await harness('only');
    fixture.respond('text("first"); console.log("debug one"); text("second"); console.warn("debug two");');
    const session = await fixture.nativeSession('only');
    await session.prompt('Format output items');

    const output = textContent(scriptResult(session).content);
    expect(output).toContain('==> text 1/2 <==\nfirst');
    expect(output).toContain('==> text 2/2 <==\nsecond');
    expect(output).toContain('<console_output>\ndebug one\ndebug two\n</console_output>');
  });

  it('omits the models namespace from script globals as well as declarations', async () => {
    const fixture = await harness('only');
    fixture.respond('return { models: typeof models, tools: typeof tools };');
    const session = await fixture.nativeSession('only');
    await session.prompt('Inspect globals');
    expect(textContent(scriptResult(session).content)).toContain('{"models":"undefined","tools":"object"}');
  });

  it.each(['on', 'only'] as const)('supports tool discovery and reports misspelled members in mode %s', async (mode) => {
    const fixture = await harness(mode);
    fixture.respond(`
      text({ read: "read" in tools, missing: "missing_fixture" in tools });
      try { tools.Read; } catch (error) { text(error.message); }
    `);
    const session = await fixture.nativeSession(mode);
    await session.prompt('Discover callable tools');

    const result = scriptResult(session);
    expect(result.isError).toBe(false);
    expect(textContent(result.content)).toContain('{"read":true,"missing":false}');
    expect(textContent(result.content)).toContain('tools.Read');
    expect(textContent(result.content)).toContain('tools.read');
    expect(result.nestedCalls).toBeUndefined();
  });

  it('returns valid images with their signature-derived MIME type', async () => {
    const fixture = await harness('only');
    const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/gT0AAAAASUVORK5CYII=';
    fixture.respond(`image({ type: "image", data: ${JSON.stringify(data)}, mimeType: "image/jpeg" });`);
    const session = await fixture.nativeSession('only');
    await session.prompt('Return an image');

    const result = scriptResult(session);
    expect(result.isError).toBe(false);
    expect(result.content).toContainEqual({ type: 'image', data, mimeType: 'image/png' });
    const savedImage = result.content.find((part) => part.type === 'text' && part.text.startsWith('[Image saved to '));
    expect(savedImage?.type).toBe('text');
    if (savedImage?.type !== 'text') throw new Error('Expected Pi to save the codemode image');
    const path = savedImage.text.match(/^\[Image saved to (.+) \(image\/png,/u)?.[1];
    expect(path).toBeDefined();
    if (!path) throw new Error('Expected a path for the codemode image output');
    try {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(path, { force: true });
    }
  });

  it.each(['not-base64!', 'aGVsbG8='])('rejects invalid image data %s', async (data) => {
    const fixture = await harness('only');
    fixture.respond(`image({ type: "image", data: ${JSON.stringify(data)}, mimeType: "image/png" });`);
    const session = await fixture.nativeSession('only');
    await session.prompt('Reject an invalid image');

    const result = scriptResult(session);
    expect(result.isError).toBe(true);
    expect(result.content.some((part) => part.type === 'image')).toBe(false);
    expect(textContent(result.content)).toContain('TypeError');
  });

  it.each(['on', 'only'] as const)('cannot bypass inspection filtering in mode %s', async (mode) => {
    const fixture = await harness(mode);
    const write = vi.spyOn(fixture.runtime, 'writeFile');
    const exec = vi.spyOn(fixture.runtime, 'exec');
    const shell = vi.spyOn(fixture.runtime, 'shell');
    fixture.respond(`
      for (const name of ['write', 'edit', 'bash']) {
        try { await tools[name]({ path: 'forbidden.txt', content: 'bad', command: 'echo bad' }); text(name + ':ran'); }
        catch { text(name + ':unavailable'); }
      }
      return ALL_TOOLS.map(tool => tool.name);
    `);
    const session = await fixture.nativeSession(mode);
    session.setActiveToolsByName(inspectionToolNames(session.getActiveToolNames()));
    await session.prompt('Try forbidden nested calls');

    const result = scriptResult(session);
    expect(result.isError).toBe(false);
    for (const name of ['write', 'edit', 'bash']) {
      expect(session.getCallableToolNames()).not.toContain(name);
      expect(textContent(result.content)).toContain(`${name}:unavailable`);
    }
    expect(textContent(result.content)).toContain('"read"');
    expect(result.nestedCalls).toBeUndefined();
    expect(write).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
    expect(shell).not.toHaveBeenCalled();
  });

  it.each(['on', 'only'] as const)('does not resurrect an empty active loadout on prompt in mode %s', async (mode) => {
    const fixture = await harness(mode);
    const contexts = fixture.respond();
    const session = await fixture.nativeSession(mode);
    session.setActiveToolsByName([]);
    await session.prompt('Synthesize without tools');
    expect(contexts).toHaveLength(1);
    expect(declaredNames(contexts[0]!)).toEqual([]);
    expect(session.getActiveToolNames()).toEqual([]);
    expect(session.agent.state.tools).toEqual([]);
    expect(session.getCallableToolNames()).toEqual([]);
  });

  it('propagates session cancellation to a running nested tool', async () => {
    const fixture = await harness('only');
    let nestedSignal: AbortSignal | undefined;
    const cancelled = vi.fn();
    fixture.respond('await tools.wait({}); return "must not complete";');
    const session = await fixture.nativeSession('only', [{
      name: 'offline-cancellation', factory: (pi) => pi.registerTool({
        name: 'wait', label: 'wait', description: 'Wait for cancellation', parameters: Type.Object({}),
        execute: async (_id, _input, signal) => {
          if (!signal) throw new Error('Expected a nested cancellation signal');
          nestedSignal = signal;
          return new Promise<{ content: { type: 'text'; text: string }[]; details: Record<string, never> }>((resolve) => {
            signal.addEventListener('abort', () => {
              cancelled();
              resolve({ content: [{ type: 'text', text: 'cancelled' }], details: {} });
            }, { once: true });
          });
        },
      }),
    }]);
    const prompt = session.prompt('Run until aborted');
    try {
      await vi.waitFor(() => expect(nestedSignal).toBeDefined());
    } finally {
      await session.abort();
      await prompt;
    }
    expect(nestedSignal!.aborted).toBe(true);
    expect(cancelled).toHaveBeenCalledOnce();
    expect(session.agent.state.isStreaming).toBe(false);
    expect(session.messages.some((message) => message.role === 'toolResult'
      && textContent(message.content).includes('must not complete'))).toBe(false);
  });
});

async function harness(mode?: LocalCodemodeMode) {
  const root = await mkdtemp(join(tmpdir(), 'felan-codemode-'));
  temporaryPaths.push(root);
  const cwd = join(root, 'workspace');
  const agentDir = join(root, 'agent');
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  const settings = async (selected?: LocalCodemodeMode) => writeFile(join(agentDir, 'settings.json'), JSON.stringify({
    builtinExtensions: Object.fromEntries(Object.keys(builtinExtensionPackages).map((name) => [name, false])),
    ...(selected === undefined ? {} : { codemode: { mode: selected } }),
  }));
  await settings(mode);
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null });
  const model = modelRuntime.getModel('openai-codex', 'gpt-5.6-luna');
  if (!model) throw new Error('Expected built-in offline test model');
  vi.spyOn(modelRuntime, 'hasConfiguredAuth').mockReturnValue(true);
  vi.spyOn(modelRuntime, 'checkAuth').mockResolvedValue({ type: 'api_key' });
  const streaming = vi.spyOn(modelRuntime, 'streamSimple').mockImplementation(() => {
    throw new Error('No provider stream is allowed in offline codemode tests');
  });
  const runtime = new HostAgentRuntime(cwd, {
    agentDir, sessionStorageRoot: join(root, 'session-storage'), agentStorageRoot: join(root, 'agent-storage'),
  });
  return {
    model, modelRuntime, runtime, settings,
    respond(code?: string) {
      const contexts: OfflineContext[] = [];
      let request = 0;
      streaming.mockImplementation((activeModel, context) => {
        contexts.push(context);
        request += 1;
        const message = assistantMessage(activeModel);
        if (code !== undefined && request === 1) {
          message.content = [{ type: 'toolCall', id: 'script-1', name: 'codemode', arguments: { code } }];
          message.stopReason = 'toolUse';
        }
        return assistantStream(message);
      });
      return contexts;
    },
    async rootRuntime(sessionManager?: SessionManager) {
      const local = await createLocalFelanRuntime({
        cwd, agentDir, homeDir: root, modelRuntime, model, skillPaths: [],
        runtimeFactory: (request) => new HostAgentRuntime(request.cwd, request),
        ...(sessionManager === undefined ? {} : { sessionManager }),
      });
      let disposed = false;
      const dispose = local.dispose.bind(local);
      local.dispose = async () => {
        if (disposed) return;
        disposed = true;
        await local.localSubagentHost.shutdown();
        await dispose();
      };
      cleanup.push(() => local.dispose());
      return local;
    },
    async nativeSession(selected: Exclude<LocalCodemodeMode, 'off'>, extensions: InlineExtension[] = []) {
      const extension = createLocalCodemodeExtension(selected)!;
      const { session } = await createAgentCoreSession({
        runtime, modelRuntime, model, agentDir, sessionManager: SessionManager.inMemory(cwd),
        settingsManager: SettingsManager.inMemory(), extensionPackages: [],
        importExtension: async () => { throw new Error('No extension packages expected'); },
        inlineExtensions: [extension, ...extensions],
      });
      cleanup.push(() => session.dispose());
      await session.bindExtensions({ mode: 'print' });
      return session;
    },
  };
}

function declaredNames(context: OfflineContext): string[] {
  return getCurrentTools(context.messages).map((tool) => tool.name).sort();
}

function scriptResult(session: AgentSession) {
  const result = session.messages.find((message) => message.role === 'toolResult' && message.toolName === 'codemode');
  if (!result || result.role !== 'toolResult') throw new Error('Expected codemode tool result');
  return result;
}

function textContent(content: string | readonly { type: string; text?: string }[]): string {
  return typeof content === 'string' ? content
    : content.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n');
}

function assistantMessage(model: Parameters<StreamFunction>[0]): AssistantMessage {
  return {
    role: 'assistant', content: [{ type: 'text', text: 'Done' }],
    api: model.api, provider: model.provider, model: model.id,
    usage: {
      input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop', timestamp: Date.now(),
  };
}

function assistantStream(message: AssistantMessage) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({ type: 'start', partial: { ...message, content: [], stopReason: 'pending' } });
    stream.push({ type: 'done', reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop', message });
  });
  return stream;
}
