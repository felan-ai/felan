import { describe, expect, it, vi } from 'vitest';
import { discoverImageModels, type ModelToolsRuntime } from '../src/index.js';

describe('authenticated image discovery', () => {
  it('has no models without a host binding', async () => {
    expect(await discoverImageModels()).toEqual([]);
  });

  it('asks the injected runtime for authenticated image models only', async () => {
    const getAvailableOfType = vi.fn().mockResolvedValue([{ id: 'image', provider: 'fake' }]);
    const models = { getAvailableOfType, generateImages: vi.fn() } as unknown as ModelToolsRuntime;
    expect(await discoverImageModels(models)).toEqual([{ id: 'image', provider: 'fake' }]);
    expect(getAvailableOfType).toHaveBeenCalledExactlyOnceWith('image');
    expect(models.generateImages).not.toHaveBeenCalled();
  });

  it('does not expose discovery errors or credentials', async () => {
    const models = { getAvailableOfType: vi.fn().mockRejectedValue(new Error('secret')), generateImages: vi.fn() } as unknown as ModelToolsRuntime;
    await expect(discoverImageModels(models)).rejects.toThrow('Configured image models could not be discovered.');
    await expect(discoverImageModels(models)).rejects.not.toThrow('secret');
  });

  it('forwards cancellation to authenticated discovery and rejects late results', async () => {
    const controller = new AbortController();
    const getAvailableOfType = vi.fn().mockImplementation(async () => { controller.abort(); return []; });
    const models = { getAvailableOfType, generateImages: vi.fn() } as unknown as ModelToolsRuntime;
    await expect(discoverImageModels(models, controller.signal)).rejects.toThrow('cancelled');
    expect(getAvailableOfType).toHaveBeenCalledExactlyOnceWith('image', undefined, { signal: controller.signal });
    await expect(discoverImageModels(models, controller.signal)).rejects.toThrow('cancelled');
    expect(getAvailableOfType).toHaveBeenCalledOnce();
  });
});
