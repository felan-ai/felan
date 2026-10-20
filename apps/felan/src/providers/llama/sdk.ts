import type { Provider } from '@felan-ai/agent-core';

export interface LlamaModelInfo {
  id: string;
  aliases?: string[];
  status: { value: 'unloaded' | 'loading' | 'loaded' | 'downloading' | 'sleeping'; args?: string[]; failed?: boolean; exit_code?: number };
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
  source?: string;
  meta?: { n_ctx?: number; n_ctx_train?: number; size?: number; ftype?: string };
}
export interface LlamaProgress { message: string; ratio?: number; detail?: string }
export interface LlamaClient {
  readonly serverUrl: string;
  list(options?: { reload?: boolean; signal?: AbortSignal }): Promise<LlamaModelInfo[]>;
  loadAndWait(model: string, update: (progress: LlamaProgress) => void, signal?: AbortSignal): Promise<LlamaModelInfo>;
  unloadAndWait(model: string, signal?: AbortSignal): Promise<void>;
  unload(model: string, signal?: AbortSignal): Promise<void>;
  downloadAndWait(model: string, update: (progress: LlamaProgress) => void, signal?: AbortSignal): Promise<LlamaModelInfo[]>;
}
export interface HuggingFaceModel { id: string; downloads: number }
export interface HuggingFaceClient {
  search(query: string, signal?: AbortSignal): Promise<HuggingFaceModel[]>;
  details(id: string, signal?: AbortSignal): Promise<{ id: string; gated: false | 'auto' | 'manual'; quantizations: Array<{ name: string; size?: number }> }>;
}
export interface LlamaSdk {
  createLlamaProvider(): {
    provider: Provider<'openai-completions'>;
    setCatalog(models: readonly LlamaModelInfo[], serverUrl: string, options?: { routerAutoload?: boolean }): void;
  };
  readonly LlamaClient: new (serverUrl: string, apiKey?: string) => LlamaClient;
  readonly HuggingFaceClient: new (token?: string) => HuggingFaceClient;
  findHuggingFaceToken(): Promise<string | undefined>;
  normalizeLlamaServerUrl(value: string): string;
  formatBytes(bytes: number): string;
}

export async function loadLlamaSdk(options: {
  resolveEntry?: (specifier: string) => string;
  importModule?: (url: string) => Promise<Record<string, unknown>>;
} = {}): Promise<LlamaSdk> {
  try {
    const entry = (options.resolveEntry ?? (specifier => import.meta.resolve(specifier)))('@earendil-works/pi-coding-agent');
    const load = options.importModule ?? (url => import(url));
    const [provider, client, huggingFace] = await Promise.all(['provider', 'client', 'huggingface']
      .map(name => load(new URL(`./extensions/llama/${name}.js`, entry).href)));
    if (typeof provider!.createLlamaProvider !== 'function' || typeof client!.LlamaClient !== 'function'
      || typeof client!.normalizeLlamaServerUrl !== 'function' || typeof client!.formatBytes !== 'function'
      || typeof huggingFace!.HuggingFaceClient !== 'function' || typeof huggingFace!.findHuggingFaceToken !== 'function') {
      throw new Error('Required llama.cpp exports are unavailable.');
    }
    return {
      createLlamaProvider: provider!.createLlamaProvider,
      LlamaClient: client!.LlamaClient,
      normalizeLlamaServerUrl: client!.normalizeLlamaServerUrl,
      formatBytes: client!.formatBytes,
      HuggingFaceClient: huggingFace!.HuggingFaceClient,
      findHuggingFaceToken: huggingFace!.findHuggingFaceToken,
    } as LlamaSdk;
  } catch (cause) {
    throw new Error('The installed Pi version is incompatible with the Felan llama.cpp adapter.', { cause });
  }
}
