import type { ImageApi, ImageModel, ModelRuntime } from '@felan-ai/agent-core';

export type ModelToolsRuntime = Pick<ModelRuntime, 'getAvailableOfType' | 'generateImages'>;

export async function discoverImageModels(models?: ModelToolsRuntime, signal?: AbortSignal): Promise<readonly ImageModel<ImageApi>[]> {
  if (signal?.aborted) throw new Error('Image request was cancelled.');
  if (!models) return [];
  try {
    const available = await (signal === undefined ? models.getAvailableOfType('image') : models.getAvailableOfType('image', undefined, { signal }));
    signal?.throwIfAborted();
    return available;
  } catch {
    if (signal?.aborted) throw new Error('Image request was cancelled.');
    throw new Error('Configured image models could not be discovered. Check host provider configuration.');
  }
}
