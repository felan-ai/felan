import type { ExtensionContext, FelanExtensionAPI } from '@felan-ai/agent-core';
import { describe, expect, it, vi } from 'vitest';
import browserExtension from '../src/index.js';
import { BrowserTestRuntime, result, VALID_PNG_HEADER } from './test-runtime.js';

const resizeImageMock = vi.hoisted(() => vi.fn(async () => ({
  data: 'aGVsbG8=',
  mimeType: 'image/png',
  originalWidth: 1,
  originalHeight: 1,
  width: 1,
  height: 1,
  wasResized: false,
})));

vi.mock('@felan-ai/agent-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@felan-ai/agent-core')>()),
  resizeImage: resizeImageMock,
}));

describe('browser extension', () => {
  it('registers one capability and one typed browser tool with on-demand skill guidance', async () => {
    const harness = await createHarness();
    expect(harness.capabilities).toEqual([{
      id: 'browser',
      instructions: expect.stringContaining('ask the user to confirm unless their current request already explicitly authorizes'),
    }]);
    expect([...harness.tools.keys()]).toEqual(['browser']);
    expect(harness.tools.get('browser').promptGuidelines).toEqual(expect.arrayContaining([
      expect.stringContaining('skill'),
      expect.stringContaining('existing browser'),
      expect.stringContaining('screenshot'),
    ]));
  });

  it('retrieves version-matched core skills and runs literal browser args with untrusted output', async () => {
    const harness = await createHarness();
    const tool = harness.tools.get('browser');

    const skill = await tool.execute('skill', {
      operation: 'skill',
      skill: 'core',
      full: true,
    }, undefined, undefined, harness.context);
    expect(skill.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('# core skill from installed CLI'),
    });
    expect(harness.runtime.calls.find((call) => call.args[0] === 'skills')?.args).toEqual([
      'skills',
      'get',
      'core',
      '--full',
      '--max-output',
      '100000',
      '--config',
      '/session/browser/agent-browser.json',
    ]);

    const opened = await tool.execute('open', {
      operation: 'run',
      args: ['open', 'https://example.com'],
    }, undefined, undefined, harness.context);
    expect(opened.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('<untrusted_browser_content') });
    expect(harness.runtime.calls.find((call) => call.args[0] === 'open')?.args).toEqual(expect.arrayContaining([
      'open',
      'https://example.com',
      '--json',
      '--content-boundaries',
      '--session',
      expect.stringMatching(/^f-[0-9a-f]{16}$/u),
      '--namespace',
      expect.stringMatching(/^f-[0-9a-f]{16}$/u),
    ]));
  });

  it('attaches a staged screenshot directly for image-capable models and closes on shutdown', async () => {
    const harness = await createHarness({ image: true });
    const tool = harness.tools.get('browser');
    const screenshot = await tool.execute('screenshot', {
      operation: 'run',
      args: ['screenshot'],
    }, undefined, undefined, harness.context);

    expect(screenshot.content.at(-1)).toEqual({ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' });
    expect(screenshot.details).toMatchObject({ screenshot: { delivered: true, mimeType: 'image/png' } });
    await harness.emit('session_shutdown');
    expect(harness.runtime.calls.at(-1)?.args).toEqual(expect.arrayContaining(['close']));
  });

  it('reports a text fallback for models without image input and blocks installation commands', async () => {
    const harness = await createHarness({ image: false });
    const tool = harness.tools.get('browser');
    const screenshot = await tool.execute('screenshot', {
      operation: 'run',
      args: ['screenshot'],
    }, undefined, undefined, harness.context);
    expect(screenshot.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('does not support image input') });

    await expect(tool.execute('install', {
      operation: 'run',
      args: ['install'],
    }, undefined, undefined, harness.context)).rejects.toThrow('does not run install');
  });

  it('propagates cancellation while retrieving a skill', async () => {
    const controller = new AbortController();
    const harness = await createHarness({ onSkill: () => controller.abort() });
    const tool = harness.tools.get('browser');

    await expect(tool.execute('skill', {
      operation: 'skill',
      skill: 'core',
    }, controller.signal, undefined, harness.context)).rejects.toThrow('aborted');
  });

  it('propagates cancellation during executable discovery', async () => {
    const controller = new AbortController();
    const harness = await createHarness({ onProbe: () => controller.abort() });
    const tool = harness.tools.get('browser');

    await expect(tool.execute('skill', {
      operation: 'skill',
      skill: 'core',
    }, controller.signal, undefined, harness.context)).rejects.toThrow('detection aborted');
    expect(harness.runtime.calls.some((call) => call.args[0] === 'skills')).toBe(false);
  });
});

async function createHarness(options: {
  image?: boolean;
  onProbe?: () => void;
  onSkill?: () => void;
} = {}) {
  const runtime = new BrowserTestRuntime(async (command, args) => {
    if (command === 'agent-browser') {
      if (args[0] === '--version') {
        options.onProbe?.();
        return result('agent-browser 0.31.1');
      }
      if (args[0] === 'skills') {
        options.onSkill?.();
        return result('# core skill from installed CLI\nUse snapshot.');
      }
      if (args[0] === 'screenshot') {
        const path = args.find((arg, index) => index > 0 && arg.endsWith('.png'))!;
        runtime.files.set(path, VALID_PNG_HEADER);
        return result(JSON.stringify({ success: true, data: { path } }));
      }
      if (args[0] === 'close') return result('{"success":true}');
      return result(JSON.stringify({ success: true, data: { ok: true } }));
    }
    return result('', 127, 'not found');
  });
  const tools = new Map<string, any>();
  const capabilities: Array<{ id: string; instructions: string }> = [];
  const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();
  const context = {
    model: {
      input: options.image === false ? ['text'] : ['text', 'image'],
    },
    sessionManager: { getSessionId: () => 'session-1' },
  } as unknown as ExtensionContext;
  const pi = {
    runtime,
    registerCapability: (capability: { id: string; instructions: string }) => capabilities.push(capability),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    on: (event: string, handler: (event: any, ctx: ExtensionContext) => unknown) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
  } as unknown as FelanExtensionAPI;

  await browserExtension(pi);
  return {
    runtime,
    tools,
    capabilities,
    context,
    async emit(event: string): Promise<void> {
      for (const handler of handlers.get(event) ?? []) await handler({}, context);
    },
  };
}
