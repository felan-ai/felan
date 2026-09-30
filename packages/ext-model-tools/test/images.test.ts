import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AgentRuntime, AgentRuntimeStorage, AssistantImages, ImageApi, ImageModel, Usage } from '@felan-ai/agent-core';
import type { ModelToolsRuntime } from '../src/index.js';
import { harness } from './harness.js';

vi.mock('node:crypto', async importOriginal => ({ ...await importOriginal<typeof import('node:crypto')>(), randomUUID: vi.fn((await importOriginal<typeof import('node:crypto')>()).randomUUID) }));

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT1sAAAAASUVORK5CYII=';
const model: ImageModel<ImageApi> = {
  type: 'image', provider: 'fake', id: 'draw', name: 'Offline image model', api: 'openai-images',
  baseUrl: 'https://not-used.invalid', headers: { Authorization: 'secret' },
  input: ['text', 'image'], output: ['text', 'image'], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
};
const response: AssistantImages = { api: model.api, provider: model.provider, model: model.id,
  timestamp: 0, stopReason: 'stop', output: [{ type: 'text', text: 'Untrusted generated description' }, { type: 'image', data: png, mimeType: 'image/png' }] };
const request = { action: 'generate', provider: 'fake', model: 'draw', prompt: 'A tree' };
const usage: Usage = { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30,
  cost: { input: 0.01, output: 0.04, cacheRead: 0, cacheWrite: 0, total: 0.05 } };

async function setup() {
  const files = new Map<string, Uint8Array>();
  const directories = new Set<string>();
  const storage: AgentRuntimeStorage = {
    root: '/session',
    readFile: vi.fn(),
    writeFile: vi.fn(async (path, data) => {
      if (files.has(path)) throw new Error('Would overwrite');
      files.set(path, data);
    }),
    appendFile: vi.fn(), listFiles: vi.fn(),
    mkdir: vi.fn(async (path, options) => {
      if (directories.has(path) && !options?.recursive) throw new Error('Already exists');
      directories.add(path);
    }),
    remove: vi.fn(async path => {
      directories.delete(path);
      for (const key of files.keys()) if (key.startsWith(`${path}/`)) files.delete(key);
    }),
  };
  const runtime: Partial<AgentRuntime> = {
    storage: vi.fn().mockReturnValue(storage),
    readFile: vi.fn().mockResolvedValue(Buffer.from(png, 'base64')),
    writeFile: vi.fn(), exec: vi.fn(), shell: vi.fn(),
  };
  const getAvailableOfType = vi.fn().mockResolvedValue([model]);
  const generateImages = vi.fn<ModelToolsRuntime['generateImages']>().mockResolvedValue(response);
  const models = { getAvailableOfType, generateImages } as unknown as ModelToolsRuntime;
  const h = await harness(runtime, models);
  return { ...h, runtime, storage, files, directories, models, getAvailableOfType, generateImages };
}

describe('generate_images', () => {
  it('lists only safe configured model fields, without credentials or inference', async () => {
    const h = await setup();
    const result = await h.execute('generate_images', { action: 'list' });
    expect(result.details).toEqual({ models: [{ provider: 'fake', model: 'draw', name: model.name, input: model.input, output: model.output }] });
    expect(JSON.stringify(result)).not.toMatch(/secret|Authorization|baseUrl/);
    expect(h.generateImages).not.toHaveBeenCalled();
    expect(h.getAvailableOfType).toHaveBeenCalledTimes(2);
  });

  it('returns text, image, unique session artifacts and real accounting usage', async () => {
    const h = await setup();
    h.generateImages.mockResolvedValue({ ...response, usage });
    const signal = new AbortController().signal;
    const first = await h.execute('generate_images', request, signal);
    const second = await h.execute('generate_images', request);
    expect(first).toMatchObject({ content: [{ type: 'text' }, ...response.output], usage,
      details: { provider: 'fake', model: 'draw', elapsedMs: expect.any(Number), usage } });
    expect(first.details).not.toEqual(second.details);
    expect(h.files.size).toBe(2);
    for (const [path, bytes] of h.files) {
      expect(path).toMatch(/^model-tools\/images\/[a-f\d-]+\/1.png$/u);
      expect(Buffer.from(bytes).toString('base64')).toBe(png);
    }
    expect(h.generateImages).toHaveBeenCalledWith(model, { input: [{ type: 'text', text: 'A tree' }] }, { signal });
    expect(h.runtime.storage).toHaveBeenCalledWith('session');
    expect(h.runtime.writeFile).not.toHaveBeenCalled();
    expect(h.runtime.exec).not.toHaveBeenCalled();
    expect(h.runtime.shell).not.toHaveBeenCalled();
    expect(JSON.stringify(first.details)).not.toContain(png);
  });

  it('reads references only through the runtime and infers MIME from bytes', async () => {
    const h = await setup();
    await h.execute('generate_images', { ...request, referencePaths: ['reference.jpg'] });
    expect(h.runtime.readFile).toHaveBeenCalledExactlyOnceWith('reference.jpg');
    expect(h.generateImages).toHaveBeenCalledWith(model, { input: [
      { type: 'text', text: 'A tree' }, { type: 'image', data: png, mimeType: 'image/png' },
    ] }, {});
  });

  it.each(['https://private.invalid/image', 'file:///private/image', 'data:image/png;base64,secret', '//remote/image', '\\\\remote\\image', '../secret', 'dir/../../secret', 'dir\\..\\secret', 'nul\0path'])('rejects unsafe reference %s', async path => {
    const h = await setup();
    await expect(h.execute('generate_images', { ...request, referencePaths: [path] })).rejects.toThrow('local paths');
    expect(h.runtime.readFile).not.toHaveBeenCalled();
    expect(h.generateImages).not.toHaveBeenCalled();
  });

  it.each([
    { action: 'generate' }, { ...request, prompt: ' ' }, { ...request, apiKey: 'secret' },
    { ...request, endpoint: 'https://not-used.invalid' }, { ...request, headers: {} },
    { action: 'list', prompt: 'unexpected' }, { ...request, referencePaths: [42] },
  ])('rejects malformed arguments %j without inference', async input => {
    const h = await setup();
    await expect(h.execute('generate_images', input)).rejects.toThrow();
    expect(h.generateImages).not.toHaveBeenCalled();
  });

  it('rejects disappearing models and discovery failures without exposing raw errors', async () => {
    const h = await setup();
    h.getAvailableOfType.mockResolvedValueOnce([]);
    await expect(h.execute('generate_images', request)).rejects.toThrow('no longer available');
    h.getAvailableOfType.mockRejectedValueOnce(new Error('secret provider body'));
    await expect(h.execute('generate_images', { action: 'list' })).rejects.toThrow('Configured image models could not be discovered. Check host provider configuration.');
    expect(h.generateImages).not.toHaveBeenCalled();
  });

  it('requires a model accepting image input before reading references', async () => {
    const h = await setup();
    h.getAvailableOfType.mockResolvedValue([{ ...model, input: ['text'] }]);
    await expect(h.execute('generate_images', { ...request, referencePaths: ['ref.png'] })).rejects.toThrow('does not accept reference images');
    expect(h.runtime.readFile).not.toHaveBeenCalled();
  });

  it('redacts reference file errors and rejects non-image bytes', async () => {
    const h = await setup();
    vi.mocked(h.runtime.readFile!).mockRejectedValueOnce(new Error('private path secret'));
    await expect(h.execute('generate_images', { ...request, referencePaths: ['ref.png'] })).rejects.toThrow('Reference image could not be read or has an unsupported raster format.');
    vi.mocked(h.runtime.readFile!).mockResolvedValueOnce(Buffer.from('<svg/>'));
    await expect(h.execute('generate_images', { ...request, referencePaths: ['ref.svg'] })).rejects.toThrow('unsupported raster format');
    expect(h.generateImages).not.toHaveBeenCalled();
  });

  it.each([
    { type: 'image', data: '%%%secret', mimeType: 'image/png' },
    { type: 'image', data: png, mimeType: 'image/jpeg' },
    { type: 'image', data: Buffer.from('<svg/>').toString('base64'), mimeType: 'image/svg+xml' },
    { type: 'image', data: 'YWJ=', mimeType: 'image/png' },
    { type: 'image', data: '', mimeType: 'image/png' },
    { type: 'text', text: 1 },
  ])('validates all output before writing artifacts: %j', async block => {
    const h = await setup();
    h.generateImages.mockResolvedValue({ ...response, output: [...response.output, block] } as AssistantImages);
    await expect(h.execute('generate_images', request)).rejects.toThrow('invalid image content');
    expect(h.storage.writeFile).not.toHaveBeenCalled();
    expect(h.storage.mkdir).not.toHaveBeenCalled();
  });

  it('does not leak provider errors or text-only responses', async () => {
    const h = await setup();
    h.generateImages.mockRejectedValueOnce(new Error('secret raw response'));
    await expect(h.execute('generate_images', request)).rejects.toThrow('Image generation failed. Check host provider configuration and request.');
    h.generateImages.mockResolvedValueOnce({ ...response, stopReason: 'error', errorMessage: 'secret raw error' });
    await expect(h.execute('generate_images', request)).rejects.toThrow('Image generation failed. Check host provider configuration and request.');
    h.generateImages.mockResolvedValueOnce({ ...response, output: [{ type: 'text', text: 'secret raw text' }] });
    await expect(h.execute('generate_images', request)).rejects.toThrow('Image provider returned no images. No artifacts were written.');
    expect(h.storage.writeFile).not.toHaveBeenCalled();
  });

  it('rejects pre-aborted, late-aborted and provider-aborted calls', async () => {
    const h = await setup();
    const controller = new AbortController();
    h.generateImages.mockImplementationOnce(async () => { controller.abort(); return response; });
    await expect(h.execute('generate_images', request, controller.signal)).rejects.toThrow('cancelled');
    await expect(h.execute('generate_images', request, controller.signal)).rejects.toThrow('cancelled');
    expect(h.generateImages).toHaveBeenCalledOnce();
    h.generateImages.mockResolvedValueOnce({ ...response, stopReason: 'aborted' });
    await expect(h.execute('generate_images', request)).rejects.toThrow('cancelled');
    expect(h.storage.writeFile).not.toHaveBeenCalled();
  });

  it('never reuses an existing artifact directory or removes its contents', async () => {
    const h = await setup();
    const id = '00000000-0000-0000-0000-000000000000';
    vi.mocked(randomUUID).mockReturnValueOnce(id);
    h.directories.add(`model-tools/images/${id}`);
    h.files.set(`model-tools/images/${id}/1.png`, Buffer.from('keep'));
    await expect(h.execute('generate_images', request)).rejects.toThrow('could not be saved');
    expect(Buffer.from([...h.files.values()][0]!).toString()).toBe('keep');
    expect(h.storage.remove).not.toHaveBeenCalled();
    expect(h.storage.writeFile).not.toHaveBeenCalled();
  });

  it('cleans up its own partial artifacts on storage failure or cancellation', async () => {
    const h = await setup();
    h.generateImages.mockResolvedValue({ ...response, output: [response.output[1]!, response.output[1]!] });
    vi.mocked(h.storage.writeFile).mockImplementationOnce(async (path, bytes) => { h.files.set(path, bytes); })
      .mockRejectedValueOnce(new Error('secret path'));
    await expect(h.execute('generate_images', request)).rejects.toThrow('could not be saved');
    expect(h.files.size).toBe(0);
    const controller = new AbortController();
    vi.mocked(h.storage.writeFile).mockImplementationOnce(async (path, bytes) => { h.files.set(path, bytes); controller.abort(); });
    await expect(h.execute('generate_images', request, controller.signal)).rejects.toThrow('cancelled');
    expect(h.files.size).toBe(0);
    expect(h.storage.remove).toHaveBeenCalledTimes(2);
  });

  it('does not invent usage or unpriced zero costs', async () => {
    const h = await setup();
    expect(await h.execute('generate_images', request)).not.toHaveProperty('usage');
    h.getAvailableOfType.mockResolvedValue([{ ...model, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }]);
    h.generateImages.mockResolvedValue({ ...response, usage: { ...usage, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    const result = await h.execute('generate_images', request);
    expect(result).not.toHaveProperty('usage');
    expect(result.details).toHaveProperty('usage.totalTokens', 30);
    expect(result.details).not.toHaveProperty('usage.cost');
  });
});

describe('conditional tool availability', () => {
  it.each([false, true])('handles images with classifier=%s and isolates discovery failure', async configured => {
    const classifier = configured ? { classify: vi.fn() } : undefined;
    for (const available of [false, true, 'error']) {
      const models = { getAvailableOfType: available === 'error' ? vi.fn().mockRejectedValue(new Error('secret')) : vi.fn().mockResolvedValue(available ? [model] : []), generateImages: vi.fn() } as unknown as ModelToolsRuntime;
      const h = await harness(classifier ? { classifier } : {}, models);
      expect([...h.tools.keys()]).toEqual([...(configured ? ['classify'] : []), ...(available === true ? ['generate_images'] : [])]);
    }
  });
});
