import { describe, expect, it } from 'vitest';
import { loadLlamaSdk } from '../src/llama/sdk.js';

describe('llama.cpp SDK boundary', () => {
  it('loads the pinned provider and clients without the mixed extension or UI', async () => {
    const loaded: string[] = [];
    const sdk = await loadLlamaSdk({ importModule: async url => { loaded.push(url); return import(url); } });
    expect(loaded.map(url => new URL(url).pathname.split('/').at(-1))).toEqual(['provider.js', 'client.js', 'huggingface.js']);
    expect(sdk.createLlamaProvider().provider.id).toBe('llama.cpp');
    expect(new sdk.LlamaClient('http://127.0.0.1:8080').serverUrl).toBe('http://127.0.0.1:8080');
    expect(sdk.normalizeLlamaServerUrl('http://127.0.0.1:8080/')).toBe('http://127.0.0.1:8080');
  });

  it('reports incompatible exports without falling back to the mixed entrypoint', async () => {
    const loaded: string[] = [];
    await expect(loadLlamaSdk({ resolveEntry: () => 'file:///fixture/dist/index.js', importModule: async url => { loaded.push(url); return {}; } }))
      .rejects.toThrow('installed Pi version is incompatible');
    expect(loaded).toHaveLength(3);
    expect(loaded.every(url => !url.endsWith('/index.js') && !url.endsWith('/ui.js'))).toBe(true);
  });
});
