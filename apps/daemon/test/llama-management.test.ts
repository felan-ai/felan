import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { ExtensionCommandContext, ExtensionFactory } from '@felan-ai/agent-core';
import { createLlamaExtension } from '../src/llama/extension.js';
import { manageLlamaModels } from '../src/llama/management.js';
import type { LlamaPresentation } from '../src/llama/presentation.js';
import type { LlamaModelInfo, LlamaSdk } from '../src/llama/sdk.js';

function fixture() {
  const models: LlamaModelInfo[] = [{ id: 'previous', status: { value: 'loaded' } }, { id: 'target', status: { value: 'unloaded' } }];
  const notify = vi.fn();
  const auth = vi.fn().mockResolvedValue({ env: { LLAMA_BASE_URL: 'http://127.0.0.1:8080' }, auth: { apiKey: 'private-test-key' } });
  const refresh = vi.fn().mockResolvedValue({ aborted: false, errors: new Map() });
  const list = vi.fn(async () => models);
  const unload = vi.fn(async (id: string) => { models.find(model => model.id === id)!.status.value = 'unloaded'; });
  const load = vi.fn(async (id: string) => { const model = models.find(model => model.id === id)!; model.status.value = 'loaded'; return model; });
  const download = vi.fn(async (_id: string) => models);
  const search = vi.fn(async () => [{ id: 'owner/model', downloads: 10 }]);
  const details = vi.fn(async () => ({ id: 'owner/model', gated: 'manual' as const, quantizations: [{ name: 'Q4_K_M', size: 1024 }] }));
  const token = vi.fn(async () => 'private-test-token');
  const setCatalog = vi.fn();
  const sdk: LlamaSdk = {
    createLlamaProvider: () => ({ provider: { id: 'llama.cpp' } as ReturnType<LlamaSdk['createLlamaProvider']>['provider'], setCatalog }),
    LlamaClient: class {
      constructor(readonly serverUrl: string, readonly apiKey?: string) {}
      list = list; unload = unload; unloadAndWait = unload; loadAndWait = load; downloadAndWait = download;
    },
    HuggingFaceClient: class { search = search; details = details; },
    findHuggingFaceToken: token, normalizeLlamaServerUrl: value => value, formatBytes: bytes => `${bytes} bytes`,
  };
  const actions: Awaited<ReturnType<LlamaPresentation['models']>>[] = [];
  const choices: Array<string | undefined> = [];
  const confirms: boolean[] = [];
  const ui: LlamaPresentation = {
    select: vi.fn(async () => choices.shift()),
    confirm: vi.fn(async () => confirms.shift() ?? false),
    models: vi.fn(async () => actions.shift() ?? { type: 'close' }),
    search: vi.fn(async callback => (await callback('model', new AbortController().signal))[0]?.id),
    status: vi.fn(),
    progress: async options => ({ cancelled: false, value: await options.run(new AbortController().signal, () => {}) }),
    dispose: vi.fn(),
  };
  const ctx = { ui: { notify }, hasUI: true, mode: 'print', modelRegistry: { getProviderAuth: auth, refresh } } as unknown as ExtensionCommandContext;
  const signal = new AbortController();
  const run = () => manageLlamaModels(ctx, sdk, sdk.createLlamaProvider(), ui, signal.signal);
  return { models, notify, auth, refresh, list, unload, load, download, search, details, token, sdk, setCatalog, actions, choices, confirms, ui, ctx, signal, run };
}

describe('daemon llama.cpp management', () => {
  it('keeps authentication in the daemon and does not contact an unconfigured server', async () => {
    const f = fixture(); f.auth.mockResolvedValue(undefined);
    await f.run();
    expect(f.notify).toHaveBeenCalledWith('Configure llama.cpp with /login llama.cpp', 'warning');
    expect(f.list).not.toHaveBeenCalled(); expect(f.ui.models).not.toHaveBeenCalled();
  });

  it('confirms unloading and preserves in-progress model information', async () => {
    const f = fixture(); const busy: LlamaModelInfo = { id: 'busy', status: { value: 'loading' } }; f.models.push(busy);
    f.actions.push({ type: 'model', model: f.models[0]! }, { type: 'model', model: f.models[0]! }, { type: 'model', model: busy });
    f.confirms.push(false, true); await f.run();
    expect(f.unload).toHaveBeenCalledTimes(1); expect(f.unload).toHaveBeenCalledWith('previous', f.signal.signal);
    expect(f.notify).toHaveBeenCalledWith('busy is loading', 'warning');
    expect(JSON.stringify(vi.mocked(f.ui.models).mock.calls)).not.toContain('private-test');
  });

  it('can load while preserving existing loaded models and refreshes the provider', async () => {
    const f = fixture(); f.actions.push({ type: 'model', model: f.models[1]! }); f.choices.push('Keep loaded and load');
    await f.run(); expect(f.unload).not.toHaveBeenCalled(); expect(f.load).toHaveBeenCalledTimes(1);
    expect(f.models.map(model => model.status.value)).toEqual(['loaded', 'loaded']);
    expect(f.refresh).toHaveBeenCalledWith(expect.objectContaining({ providers: ['llama.cpp'], allowNetwork: true }));
  });

  it('restores replacement models when loading fails', async () => {
    const f = fixture(); f.actions.push({ type: 'model', model: f.models[1]! }); f.choices.push('Unload all and load');
    f.load.mockRejectedValueOnce(new Error('load failed')); await f.run();
    expect(f.load.mock.calls.map(call => call[0])).toEqual(['target', 'previous']);
    expect(f.models[0]!.status.value).toBe('loaded'); expect(f.notify).toHaveBeenCalledWith('load failed', 'error');
  });

  it('restores cancelled replacement exactly once, including a failed restoration', async () => {
    const f = fixture(); f.actions.push({ type: 'model', model: f.models[1]! }); f.choices.push('Unload all and load');
    f.ui.progress = async () => ({ cancelled: true }); f.load.mockRejectedValueOnce(new Error('restore failed'));
    await f.run(); expect(f.load).toHaveBeenCalledTimes(1); expect(f.load).toHaveBeenCalledWith('previous', expect.any(Function), f.signal.signal);
    expect(f.notify).toHaveBeenCalledWith('restore failed', 'error');
  });

  it('requires gated access acknowledgement and preserves the recommended quantization', async () => {
    const f = fixture(); f.actions.push({ type: 'download' }); f.choices.push('Continue', 'Q4_K_M · 1024 bytes · recommended');
    await f.run(); expect(f.details).toHaveBeenCalledWith('owner/model', expect.any(AbortSignal));
    expect(f.download).toHaveBeenCalledWith('owner/model:Q4_K_M', expect.any(Function), expect.any(AbortSignal));
    expect(f.ui.select).toHaveBeenCalledWith(expect.stringContaining('Manual approval is required'), ['Continue', 'Back']);
    expect(JSON.stringify(vi.mocked(f.ui.select).mock.calls)).not.toContain('private-test');
  });

  it('does not download when gated access is declined', async () => {
    const f = fixture(); f.actions.push({ type: 'download' }); f.choices.push('Back'); await f.run();
    expect(f.download).not.toHaveBeenCalled();
  });

  it('retains an explicitly selected quantization without asking again', async () => {
    const f = fixture(); f.ui.search = async () => 'owner/model:Q8_0'; f.actions.push({ type: 'download' }); f.choices.push('Continue');
    await f.run(); expect(f.download).toHaveBeenCalledWith('owner/model:Q8_0', expect.any(Function), expect.any(AbortSignal));
    expect(f.ui.select).toHaveBeenCalledTimes(1);
  });

  it('retries connection errors only after an explicit choice', async () => {
    const f = fixture(); f.list.mockRejectedValueOnce(new Error('fetch failed')); f.choices.push('Retry'); await f.run();
    expect(f.list).toHaveBeenCalledTimes(2); expect(f.ui.select).toHaveBeenCalledWith(expect.stringContaining('Could not connect'), ['Retry', 'Close']);
  });

  it('redacts credential material before displaying server errors', async () => {
    const f = fixture(); f.auth.mockResolvedValue({ env: { LLAMA_BASE_URL: 'http://username:password@127.0.0.1:8080' }, auth: { apiKey: 'private-test-key' } });
    f.list.mockRejectedValueOnce(new Error('Denied private-test-key for http://username:password@127.0.0.1:8080 username password'));
    f.choices.push('Close'); await f.run();
    const text = JSON.stringify(vi.mocked(f.ui.select).mock.calls);
    for (const secret of ['private-test-key', 'username', 'password']) expect(text).not.toContain(secret);
    expect(text).toContain('[redacted]');
  });

  it('does not restore or refresh after lifetime cancellation', async () => {
    const f = fixture(); f.actions.push({ type: 'model', model: f.models[1]! }); f.choices.push('Unload all and load');
    f.ui.progress = async () => { f.signal.abort(new Error('shutdown')); throw f.signal.signal.reason; };
    await expect(f.run()).rejects.toThrow('shutdown'); expect(f.load).not.toHaveBeenCalled(); expect(f.refresh).toHaveBeenCalledTimes(1);
  });

  it('registers the provider without UI and joins active management on shutdown', async () => {
    const f = fixture(); let command: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
    let shutdown: (() => Promise<void>) | undefined; let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const presentation = (_ui: ExtensionCommandContext['ui'], signal: AbortSignal): LlamaPresentation => ({ ...f.ui,
      models: () => new Promise((_, reject) => { started(); signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }) });
    const registerProvider = vi.fn();
    await createLlamaExtension({ loadSdk: async () => f.sdk, presentation })({ registerProvider,
      registerCommand: (_name: string, definition: { handler: typeof command }) => { command = definition.handler; },
      on: (_event: string, handler: typeof shutdown) => { shutdown = handler; },
    } as unknown as Parameters<ExtensionFactory>[0]);
    expect(registerProvider).toHaveBeenCalledWith(expect.objectContaining({ id: 'llama.cpp' }));
    await command!('', { ...f.ctx, hasUI: false }); expect(f.auth).not.toHaveBeenCalled();
    const pending = command!('', f.ctx); await entered; await shutdown!(); await pending;
    expect(f.ui.dispose).toHaveBeenCalled();
  });

  it('does not import client renderers or mixed Pi extension entrypoints', () => {
    for (const name of ['sdk', 'management', 'presentation', 'extension']) {
      const source = readFileSync(new URL(`../src/llama/${name}.ts`, import.meta.url), 'utf8');
      expect(source).not.toMatch(/(?:pi-tui|\/llama\/ui|\/llama\/index|apps\/felan|@felan-ai\/felan)/u);
    }
  });
});
