import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FelanExtensionAPI, FelanToolInvocationResult } from '@felan-ai/agent-core';
import extension from '../src/index.js';

const TYPE_STRIP_WARNING = 'stripTypeScriptTypes is an experimental feature and might change at any time';

afterEach(() => vi.restoreAllMocks());

describe('run extension', () => {
  it('executes code and composes active tools through the invoker', async () => {
    const emitWarning = vi.spyOn(process, 'emitWarning');
    const tools = new Map<string, any>();
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const invoke = vi.fn(async (name: string, input: unknown): Promise<FelanToolInvocationResult> => ({
      toolCallId: 'nested-1',
      isError: false,
      content: [{ type: 'text', text: `${name}:${JSON.stringify(input)}` }],
      details: undefined,
    }));
    const pi = fakePi(tools, handlers, invoke, ['echo'], ['echo']);
    extension(pi);
    await handlers.get('session_start')?.();

    const runCode = tools.get('run_code');
    const result = await runCode.execute('outer', {
      title: 'Compose echo results',
      source: 'const a = await tools.echo({ value: 2 }); return { a, total: 3 + 4 };',
    });
    expect(result).toEqual({
      content: [{ type: 'text', text: '{"a":"echo:{\\"value\\":2}","total":7}' }],
      details: {
        calls: [{
          name: 'echo',
          toolCallId: 'nested-1',
          arguments: '{"value":2}',
          isError: false,
          terminate: false,
          outcome: 'echo:{"value":2}',
        }],
        callsTruncated: false,
      },
    });
    expect(invoke).toHaveBeenCalledWith('echo', { value: 2 }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(handlers.get('tool_result')?.({
      toolName: 'run_code', toolCallId: 'outer', ...result, isError: false,
    })).toBeUndefined();
    expect(emitWarning.mock.calls.some((call) => (
      call[0] === TYPE_STRIP_WARNING && (call[1] as unknown) === 'ExperimentalWarning'
    ))).toBe(false);
  });

  it('keeps the guest away from Node and excludes forbidden tools', async () => {
    const tools = new Map<string, any>();
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const pi = fakePi(tools, handlers, async () => {
      throw new Error('should not be called');
    }, ['echo', 'run_code', 'enter_prewalk', 'exit_plan_mode', 'enter_plan_mode']);
    extension(pi);
    await handlers.get('session_start')?.();
    const runCode = tools.get('run_code');
    for (const name of ['run_code', 'enter_prewalk', 'exit_plan_mode', 'enter_plan_mode']) {
      expect(runCode.description).not.toContain(`- tools.${name}(`);
    }

    await expect(runCode.execute('outer', {
      title: 'Check sandbox globals',
      source: 'try { await tools.enter_prewalk({}); return "called"; } catch (error) { return { process: typeof process, fetch: typeof fetch, error: String(error) }; }',
    })).resolves.toMatchObject({
      content: [{ type: 'text', text: '{"process":"undefined","fetch":"undefined","error":"RunHostFunctionError: Unknown host function: tools.enter_prewalk"}' }],
    });
  });

  it('makes nested errors catchable and rejects non-text results', async () => {
    const tools = new Map<string, any>();
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const pi = fakePi(tools, handlers, async (name): Promise<FelanToolInvocationResult> => name === 'bad'
      ? { toolCallId: 'bad', isError: true, content: [{ type: 'text', text: 'denied' }], details: undefined }
      : { toolCallId: 'image', isError: false, content: [{ type: 'image', data: 'x', mimeType: 'image/png' }], details: undefined }, ['bad', 'image'], ['bad', 'image']);
    extension(pi);
    await handlers.get('session_start')?.();
    const runCode = tools.get('run_code');

    await expect(runCode.execute('outer', {
      title: 'Handle a nested failure',
      source: 'try { await tools.bad({}); } catch (error) { return String(error); }',
    })).resolves.toMatchObject({
      content: [{ type: 'text', text: '"Error: Host function failed."' }],
      details: {
        calls: [{ name: 'bad', arguments: '{}', toolCallId: 'bad', isError: true, terminate: false, outcome: 'denied' }],
        callsTruncated: false,
      },
    });
    expect(handlers.get('tool_result')?.({
      toolName: 'run_code', toolCallId: 'outer', isError: false,
    })).toBeUndefined();
    await expect(runCode.execute('image-outer', {
      title: 'Read an image result',
      source: 'return await tools.image({});',
    })).rejects.toThrow('Host function failed');
    expect(handlers.get('tool_result')?.({
      toolName: 'run_code', toolCallId: 'image-outer', isError: true,
    })).toMatchObject({ details: { calls: [{
      name: 'image', toolCallId: 'image', isError: true, outcome: 'Nested tool returned non-text content',
    }] } });
  });

  it('retains host-only audit for configured side effects and redacts sensitive keys recursively', async () => {
    const input = {
      target: '\u001b]0;hidden\u0007record\u0000\nname',
      nested: [{
        CREDENTIALS: 'credential-value',
        clientSecret: 'secret-value',
        Access_TOKEN: 'token-value',
        PaSsWoRd: 'password-value',
        'Set-Cookie': 'cookie-value',
        AUTHORIZATION: 'authorization-value',
        'Private-Key': 'private-key-value',
        private_key_pem: 'private-key-pem-value',
        apiKey: 'api-key-value',
        '\u001b[31mToKeN\u001b[0m': 'hidden-key-value',
      }],
    };
    const invoke = vi.fn(async (): Promise<FelanToolInvocationResult> => ({
      toolCallId: '\u001b[31mnested\u001b[0m',
      content: [{ type: 'text', text: '\u001b]0;hidden\u0007changed\u0000\nrecord' }],
      isError: false,
      details: { private: 'not part of the audit' },
    }));
    const { runCode } = harness(invoke);
    const result = await runCode.execute('outer', {
      title: 'Update a record',
      source: `await tools.mutate(${JSON.stringify(input)}); return "done";`,
    });

    expect(invoke).toHaveBeenCalledWith('mutate', input, expect.anything());
    expect(result.content).toEqual([{ type: 'text', text: '"done"' }]);
    expect(result.details).toEqual({
      calls: [{
        name: 'mutate', toolCallId: 'nested', isError: false, terminate: false,
        arguments: expect.any(String), outcome: 'changed  record',
      }],
      callsTruncated: false,
    });
    const args = JSON.parse(result.details.calls[0].arguments);
    expect(args.target).toBe('record  name');
    expect(Object.values(args.nested[0])).toEqual(Array(10).fill('[REDACTED]'));
    expect(Object.keys(args.nested[0])).toContain('ToKeN');
    expect(JSON.stringify(result.details)).not.toMatch(/-value|hidden|not part of the audit|\\u001b|\\u0000/u);
  });

  it.each([new Error('\u001b[31mwrite failed\u001b[0m\u0000'), undefined])(
    'audits a caught invoker rejection without inventing a nested ID (%s)',
    async (failure) => {
      const { runCode } = harness(async () => { throw failure; });
      const result = await runCode.execute('outer', {
        title: 'Handle a failed write',
        source: 'try { await tools.mutate({ id: 2 }); } catch {} return "recovered";',
      });
      expect(result).toEqual({
        content: [{ type: 'text', text: '"recovered"' }],
        details: {
          calls: [{
            name: 'mutate', arguments: '{"id":2}', isError: true, terminate: false,
            outcome: failure === undefined ? 'undefined' : 'write failed ',
          }],
          callsTruncated: false,
        },
      });
    },
  );

  it.each([false, true])('propagates nested termination despite guest catch (isError: %s)', async (isError) => {
    const content = [{ type: 'text' as const, text: 'Stop this turn' }];
    let nestedSignal: AbortSignal | undefined;
    const invoke = vi.fn(async (_name, _input, options): Promise<FelanToolInvocationResult> => {
      nestedSignal = (options as { signal: AbortSignal }).signal;
      return { toolCallId: 'stop', isError, terminate: true, content, details: undefined };
    });
    const { runCode, handlers } = harness(invoke);
    const started = Date.now();
    const result = await runCode.execute('outer', {
      title: 'Stop on nested policy',
      source: 'try { await tools.mutate({}); } catch { while (true) {} } await tools.mutate({ after: true }); while (true) {}',
    }, AbortSignal.timeout(2_000));

    expect(Date.now() - started).toBeLessThan(1_500);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(nestedSignal?.aborted).toBe(true);
    expect(result).toEqual({
      content, terminate: true,
      details: {
        calls: [{ name: 'mutate', toolCallId: 'stop', arguments: '{}', isError, terminate: true, outcome: 'Stop this turn' }],
        callsTruncated: false,
      },
    });
    const event = { toolName: 'run_code', toolCallId: 'outer', ...result, isError: false };
    expect(handlers.get('tool_result')?.(event)).toEqual(isError ? { isError: true } : undefined);
    expect(handlers.get('tool_result')?.(event)).toBeUndefined();
  });

  it.each([
    ['image', [{ type: 'image', data: 'x', mimeType: 'image/png' }], 'Nested tool returned non-text content'],
    ['oversized', [{ type: 'text', text: 'x'.repeat(1_024 * 1_024 + 1) }], 'Nested tool output exceeded its code-mode limit'],
    ['escaped', [{ type: 'text', text: '"'.repeat(600_000) }], 'Nested tool output exceeded its code-mode limit'],
    ['invalid block', [null], 'Nested tool returned invalid content'],
    ['invalid text', [{ type: 'text', text: 1 }], 'Nested tool returned invalid text content'],
    ['many blocks', Array.from({ length: 1_025 }, () => ({ type: 'text', text: '' })), 'Nested tool returned too many content blocks'],
  ] as const)('keeps %s termination output inside the nested-result boundary', async (_kind, content, message) => {
    const { runCode, handlers } = harness(async (): Promise<FelanToolInvocationResult> => ({
      toolCallId: 'stop', isError: false, terminate: true,
      content: content as FelanToolInvocationResult['content'], details: undefined,
    }));
    const result = await runCode.execute('outer', {
      title: 'Stop on bounded termination',
      source: 'try { await tools.mutate({}); } catch {} while (true) {}',
    }, AbortSignal.timeout(2_000));
    expect(result).toMatchObject({
      content: [{ type: 'text', text: message }],
      terminate: true,
      details: { calls: [{ isError: true, terminate: true, outcome: message }] },
    });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(64 * 1_024);
    expect(handlers.get('tool_result')?.({
      toolName: 'run_code', toolCallId: 'outer', ...result, isError: false,
    })).toEqual({ isError: true });
  });

  it('normalizes termination text blocks before returning them', async () => {
    const { runCode } = harness(async (): Promise<FelanToolInvocationResult> => ({
      toolCallId: 'stop', isError: false, terminate: true,
      content: [{ type: 'text', text: 'Stop safely', extra: 'x'.repeat(2 * 1_024 * 1_024) }] as any,
      details: undefined,
    }));
    const result = await runCode.execute('outer', {
      title: 'Normalize termination output',
      source: 'await tools.mutate({});',
    });

    expect(result.content).toEqual([{ type: 'text', text: 'Stop safely' }]);
    expect(result.terminate).toBe(true);
    expect(JSON.stringify(result)).not.toContain('extra');
  });

  it('bounds errors thrown while inspecting termination content', async () => {
    const block = Object.defineProperty({}, 'type', {
      get: () => { throw new Error(`\u001b[31m${'x'.repeat(2 * 1_024 * 1_024)}\u001b[0m`); },
    });
    const { runCode, handlers } = harness(async (): Promise<FelanToolInvocationResult> => ({
      toolCallId: 'stop', isError: false, terminate: true,
      content: [block] as FelanToolInvocationResult['content'], details: undefined,
    }));
    const result = await runCode.execute('outer', {
      title: 'Bound termination validation errors',
      source: 'await tools.mutate({});',
    });

    expect(result.terminate).toBe(true);
    expect(result.content[0]).toMatchObject({ type: 'text' });
    expect(Buffer.byteLength((result.content[0] as { text: string }).text)).toBeLessThanOrEqual(4 * 1_024);
    expect((result.content[0] as { text: string }).text).toContain('[Truncated]');
    expect(JSON.stringify(result)).not.toContain('\u001b');
    expect(handlers.get('tool_result')?.({
      toolName: 'run_code', toolCallId: 'outer', ...result, isError: false,
    })).toEqual({ isError: true });
  });

  it('marks lossy rich-value and sanitized-key audit summaries as truncated', async () => {
    const { runCode } = harness(async (): Promise<FelanToolInvocationResult> => ({
      toolCallId: 'nested', isError: false,
      content: [{ type: 'text', text: 'done' }], details: undefined,
    }));
    const result = await runCode.execute('outer', {
      title: 'Audit rich arguments',
      source: `return await tools.mutate({
        when: new Date("2026-01-02T03:04:05.000Z"),
        matcher: /audit/gi,
        values: new Map([["one", 1]]),
        selected: new Set(["one"]),
        bytes: new Uint8Array([1, 2, 3]),
        issue: new Error("bad input"),
        negativeZero: -0,
        "same\\u0000key": 1,
        "same key": 2,
      });`,
    });

    const args = JSON.parse(result.details.calls[0].arguments);
    expect(args).toMatchObject({
      when: '[Date 2026-01-02T03:04:05.000Z]',
      matcher: '[RegExp /audit/gi]',
      values: '[Map with 1 entries]',
      selected: '[Set with 1 values]',
      bytes: '[Uint8Array with 3 bytes]',
      issue: '[Error: bad input]',
      negativeZero: '-0',
      'same key': 1,
    });
    expect(result.details.callsTruncated).toBe(true);
  });

  it('retains audit by outer ID when guest execution throws and consumes only matching result events', async () => {
    const { runCode, handlers } = harness(async (_name, input): Promise<FelanToolInvocationResult> => ({
      toolCallId: `nested-${(input as { id: string }).id}`,
      content: [{ type: 'text', text: 'written' }], isError: false, details: undefined,
    }));
    for (const id of ['one', 'two']) {
      await expect(runCode.execute(id, {
        title: 'Write then fail',
        source: `await tools.mutate({ id: "${id}" }); throw new Error("guest failed");`,
      })).rejects.toThrow('guest failed');
    }
    const handler = handlers.get('tool_result')!;
    expect(handler({ toolName: 'mutate', toolCallId: 'one' })).toBeUndefined();
    expect(handler({ toolName: 'run_code', toolCallId: 'unknown' })).toBeUndefined();
    for (const id of ['two', 'one']) {
      const event = {
        toolName: 'run_code', toolCallId: id, isError: true,
        content: [{ type: 'text', text: 'guest failed' }], details: {},
      };
      expect(handler(event)).toEqual({ details: {
        calls: [{
          name: 'mutate', toolCallId: `nested-${id}`, arguments: JSON.stringify({ id }),
          isError: false, terminate: false, outcome: 'written',
        }],
        callsTruncated: false,
      } });
      expect(handler(event)).toBeUndefined();
    }
  });

  it.each(['session_start', 'session_shutdown'])('clears unconsumed failure state on %s', async (event) => {
    const { runCode, handlers } = harness(async () => { throw new Error('unused'); });
    await expect(runCode.execute('outer', { title: 'Fail', source: 'throw new Error("failed");' })).rejects.toThrow('failed');
    await handlers.get(event)?.();
    expect(handlers.get('tool_result')?.({ toolName: 'run_code', toolCallId: 'outer', isError: true })).toBeUndefined();
  });

  it('bounds every audit field in UTF-8 and flags truncation without changing model content', async () => {
    const name = 'x'.repeat(128);
    const { runCode } = harness(async (): Promise<FelanToolInvocationResult> => ({
      toolCallId: '界'.repeat(200),
      content: [{ type: 'text', text: '界'.repeat(2_000) }],
      isError: false, details: undefined,
    }), [name]);
    const result = await runCode.execute('outer', {
      title: 'Bound audit fields',
      source: `await tools.${name}({ value: "界".repeat(2000) }); return "done";`,
    });
    const call = result.details.calls[0];
    expect(result.content).toEqual([{ type: 'text', text: '"done"' }]);
    expect(result.details.callsTruncated).toBe(true);
    expect(Buffer.byteLength(call.name)).toBeLessThanOrEqual(128);
    expect(Buffer.byteLength(call.toolCallId)).toBeLessThanOrEqual(256);
    expect(Buffer.byteLength(call.arguments)).toBeLessThanOrEqual(2_048);
    expect(Buffer.byteLength(call.outcome)).toBeLessThanOrEqual(2_048);
    expect(call.arguments).toContain('[Truncated]');
    expect(JSON.stringify(call)).not.toContain('\uFFFD');
  });

  it('bounds total serialized audit bytes including escaping and flags dropped entries', async () => {
    const invoke = vi.fn(async (): Promise<FelanToolInvocationResult> => ({
      toolCallId: 'nested', content: [{ type: 'text', text: '"'.repeat(1_000) }], isError: false, details: undefined,
    }));
    const { runCode } = harness(invoke);
    const result = await runCode.execute('outer', {
      title: 'Bound total audit',
      source: 'for (let i = 0; i < 100; i++) await tools.mutate({ value: "x".repeat(1000) }); return "done";',
    });
    expect(invoke).toHaveBeenCalledTimes(100);
    expect(result.content).toEqual([{ type: 'text', text: '"done"' }]);
    expect(result.details.calls.length).toBeGreaterThan(0);
    expect(result.details.calls.length).toBeLessThan(100);
    expect(result.details.callsTruncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result.details))).toBeLessThanOrEqual(64 * 1_024);
  });

  it('retains bounded audit when the bridge call-count limit fails the outer run', async () => {
    const invoke = vi.fn(async (): Promise<FelanToolInvocationResult> => ({
      toolCallId: 'nested', content: [{ type: 'text', text: 'ok' }], isError: false, details: undefined,
    }));
    const { runCode, handlers } = harness(invoke);
    await expect(runCode.execute('outer', {
      title: 'Bound nested calls',
      source: 'for (let i = 0; i < 260; i++) await tools.mutate({});',
    })).rejects.toThrow();
    const patch = handlers.get('tool_result')?.({ toolName: 'run_code', toolCallId: 'outer', isError: true }) as any;
    expect(invoke).toHaveBeenCalledTimes(256);
    expect(patch.details.calls).toHaveLength(256);
    expect(Buffer.byteLength(JSON.stringify(patch.details))).toBeLessThanOrEqual(64 * 1_024);
  });

  it('renders a safe descriptive title', async () => {
    const tools = new Map<string, any>();
    const handlers = new Map<string, (...args: any[]) => unknown>();
    extension(fakePi(tools, handlers, async () => {
      throw new Error('unused');
    }, [], []));
    const runCode = tools.get('run_code');

    expect(runCode.parameters.required).toEqual(['title', 'source']);
    const rendered = runCode.renderCall({
      title: 'Inspect\u001b]0;hidden\u0007\nextension wiring',
      source: 'return 1;',
    }, {
      fg: (_role: string, text: string) => text,
      bold: (text: string) => text,
    }, {}).render(200).join('\n').trimEnd();
    expect(rendered).toBe('Run Code - Inspect extension wiring');
  });
});

function harness(
  invoke: (name: string, input: unknown, options: unknown) => Promise<FelanToolInvocationResult>,
  names = ['mutate'],
) {
  const tools = new Map<string, any>();
  const handlers = new Map<string, (...args: any[]) => unknown>();
  extension(fakePi(tools, handlers, invoke, names));
  handlers.get('session_start')?.();
  return { runCode: tools.get('run_code'), handlers };
}

function fakePi(
  tools: Map<string, any>,
  handlers: Map<string, (...args: any[]) => unknown>,
  invoke: (name: string, input: unknown, options: unknown) => Promise<FelanToolInvocationResult>,
  names = ['echo', 'bad', 'image'],
  configNames = names,
): FelanExtensionAPI {
  return {
    config: { toolNames: configNames },
    toolInvoker: { invoke },
    getActiveTools: () => names,
    getAllTools: () => names.map((name) => ({
      name,
      description: `${name} description`,
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      sourceInfo: { source: 'test' },
    })),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    on: (name: string, handler: (...args: any[]) => unknown) => handlers.set(name, handler),
    registerCapability: () => {},
  } as unknown as FelanExtensionAPI;
}
