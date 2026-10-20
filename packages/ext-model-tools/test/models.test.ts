import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { MODELS_SERVICE, type ImageModelInfo, type ModelsService } from '@felan-ai/agent-core';
import { discoverImageModels, type ModelToolsRuntime } from '../src/index.js';
import modelToolsExtension from '../src/extension.js';
import { fakeModelsService, harness } from './harness.js';

const image: ImageModelInfo = {
  type: 'image', provider: 'fake', id: 'image', name: 'Offline Image', api: 'openai-images',
  input: ['text'], output: ['image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

describe('authenticated image discovery', () => {
  it('keeps classification available when the optional model service is missing', async () => {
    expect(modelToolsExtension.serviceRequirements).toEqual({ optional: [MODELS_SERVICE] });
    const h = await harness({ classifier: { classify: vi.fn() } });
    expect([...h.tools.keys()]).toEqual(['classify']);
  });

  it('exports no feature-specific service contract', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(Object.keys(manifest.exports)).toEqual(['.']);
  });

  it('preserves the model service receiver and forwards discovery cancellation', async () => {
    const models: ModelsService = fakeModelsService({
      getAvailableOfType: vi.fn().mockImplementation(async function (this: ModelsService) {
        expect(this).toBe(models);
        return [image];
      }),
    });
    const h = await harness({}, models);
    const signal = new AbortController().signal;
    await h.execute('generate_images', { action: 'list' }, signal);
    expect(models.getAvailableOfType).toHaveBeenLastCalledWith('image', undefined, { signal });
    expect(models.generateImages).not.toHaveBeenCalled();
  });

  it('has no models without a host binding', async () => {
    expect(await discoverImageModels()).toEqual([]);
  });

  it('asks the injected runtime for authenticated image models only', async () => {
    const getAvailableOfType = vi.fn().mockResolvedValue([image]);
    const models: ModelToolsRuntime = { getAvailableOfType, generateImages: vi.fn() };
    expect(await discoverImageModels(models)).toEqual([image]);
    expect(getAvailableOfType).toHaveBeenCalledExactlyOnceWith('image');
    expect(models.generateImages).not.toHaveBeenCalled();
  });

  it('does not expose discovery errors or credentials', async () => {
    const models: ModelToolsRuntime = { getAvailableOfType: vi.fn().mockRejectedValue(new Error('secret')), generateImages: vi.fn() };
    await expect(discoverImageModels(models)).rejects.toThrow('Configured image models could not be discovered.');
    await expect(discoverImageModels(models)).rejects.not.toThrow('secret');
  });

  it('forwards cancellation to authenticated discovery and rejects late results', async () => {
    const controller = new AbortController();
    const getAvailableOfType = vi.fn().mockImplementation(async () => { controller.abort(); return []; });
    const models: ModelToolsRuntime = { getAvailableOfType, generateImages: vi.fn() };
    await expect(discoverImageModels(models, controller.signal)).rejects.toThrow('cancelled');
    expect(getAvailableOfType).toHaveBeenCalledExactlyOnceWith('image', undefined, { signal: controller.signal });
    await expect(discoverImageModels(models, controller.signal)).rejects.toThrow('cancelled');
    expect(getAvailableOfType).toHaveBeenCalledOnce();
  });
});
