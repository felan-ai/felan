import type { ExtensionCommandContext } from '@felan-ai/agent-core';
import type { LlamaPresentation } from './presentation.js';
import type { LlamaModelInfo, LlamaSdk } from './sdk.js';

const PROVIDER = 'llama.cpp';
const loaded = (model: LlamaModelInfo) => model.status.value === 'loaded' || model.status.value === 'sleeping';
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const connectionError = (error: unknown) => error instanceof Error && /fetch failed|timeout|network/i.test(`${error.name} ${error.message}`);

export async function manageLlamaModels(ctx: ExtensionCommandContext, sdk: LlamaSdk,
  provider: ReturnType<LlamaSdk['createLlamaProvider']>, ui: LlamaPresentation, signal: AbortSignal): Promise<void> {
  const auth = await ctx.modelRegistry.getProviderAuth(PROVIDER);
  signal.throwIfAborted();
  if (!auth) { ctx.ui.notify('Configure llama.cpp with /login llama.cpp', 'warning'); return; }
  const configuredUrl = auth.env?.LLAMA_BASE_URL;
  const client = new sdk.LlamaClient(sdk.normalizeLlamaServerUrl(typeof configuredUrl === 'string' && configuredUrl ? configuredUrl : auth.auth.baseUrl ?? ''), auth.auth.apiKey);
  const address = new URL(client.serverUrl);
  const secrets = new Set([auth.auth.apiKey, decodeURIComponent(address.username), decodeURIComponent(address.password)].filter((value): value is string => Boolean(value)));
  address.username = ''; address.password = '';
  const server = address.toString().replace(/\/$/u, '');
  const safeMessage = (error: unknown) => {
    let text = message(error).replaceAll(client.serverUrl, server);
    for (const secret of secrets) text = text.replaceAll(secret, '[redacted]');
    return text;
  };
  const timeout = () => AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
  const sync = async (catalog?: LlamaModelInfo[]) => {
    signal.throwIfAborted();
    const scoped = timeout();
    const current = catalog ?? await client.list({ signal: scoped });
    scoped.throwIfAborted();
    provider.setCatalog(current, client.serverUrl);
    const result = await ctx.modelRegistry.refresh({ providers: [PROVIDER], allowNetwork: true, signal: scoped });
    scoped.throwIfAborted();
    if (result.aborted) throw new Error('Model catalog refresh timed out.');
    const error = result.errors.get(PROVIDER);
    if (error) throw error;
    return current;
  };
  const read = async () => {
    while (true) {
      try { return await sync(); }
      catch (error) {
        signal.throwIfAborted();
        const detail = connectionError(error) ? 'Could not connect to the server.' : safeMessage(error);
        if (await ui.select(`${server}\n${detail}`, ['Retry', 'Close']) !== 'Retry') return undefined;
      }
    }
  };
  const restore = async (models: readonly LlamaModelInfo[]) => {
    signal.throwIfAborted();
    ctx.ui.notify('Restoring previously loaded models');
    for (const model of models) { signal.throwIfAborted(); await client.loadAndWait(model.id, () => {}, signal); }
    await sync();
  };
  const load = async (catalog: readonly LlamaModelInfo[], target: LlamaModelInfo) => {
    const previous = catalog.filter(model => model.id !== target.id && loaded(model));
    const choice = previous.length ? await ui.select(`${previous.length} model${previous.length === 1 ? ' is' : 's are'} loaded`,
      ['Unload all and load', 'Keep loaded and load', 'Cancel']) : 'Keep loaded and load';
    if (choice === undefined || choice === 'Cancel') return;
    const replace = choice === 'Unload all and load';
    let restorationAttempted = false;
    try {
      if (replace) for (const model of previous) { signal.throwIfAborted(); await client.unloadAndWait(model.id, signal); }
      const result = await ui.progress({ title: 'Loading model', model: target.id, cancelTitle: 'Stop loading?',
        run: (progressSignal, update) => client.loadAndWait(target.id, update, progressSignal),
        cancel: () => client.unload(target.id, timeout()) });
      signal.throwIfAborted();
      if (result.cancelled) { if (replace) { restorationAttempted = true; await restore(previous); } return; }
      const refreshed = await sync();
      ctx.ui.notify(refreshed.find(model => model.id === target.id)?.status.value === 'loaded' ? `Loaded ${target.id}` : `Load started for ${target.id}`);
    } catch (error) {
      if (replace && !restorationAttempted && !signal.aborted) {
        try { await restore(previous); }
        catch (restoreError) { signal.throwIfAborted(); ctx.ui.notify(`Could not restore previously loaded models: ${safeMessage(restoreError)}`, 'warning'); }
      }
      throw error;
    }
  };
  const download = async () => {
    const token = await sdk.findHuggingFaceToken();
    signal.throwIfAborted();
    if (token) secrets.add(token);
    const huggingFace = new sdk.HuggingFaceClient(token);
    const selected = await ui.search((query, searchSignal) => huggingFace.search(query, AbortSignal.any([signal, searchSignal, AbortSignal.timeout(15_000)])));
    if (!selected) return;
    signal.throwIfAborted();
    const colon = selected.indexOf(':', selected.indexOf('/') + 1);
    const repository = colon < 0 ? selected : selected.slice(0, colon);
    let quantization = colon < 0 ? undefined : selected.slice(colon + 1);
    ui.status('Loading model details', repository);
    const details = await huggingFace.details(repository, timeout());
    signal.throwIfAborted();
    if (details.gated) {
      const approval = details.gated === 'manual' ? 'Manual approval is required' : 'Accept the access terms';
      if (await ui.select(`Hugging Face access required\n${details.id}\n${approval} at:\nhttps://huggingface.co/${details.id}\nThe llama.cpp server needs HF_TOKEN with access.`, ['Continue', 'Back']) !== 'Continue') return;
    }
    if (!quantization && details.quantizations.length) {
      const choices = details.quantizations.map(entry => [entry.name, entry.size === undefined ? undefined : sdk.formatBytes(entry.size),
        entry.name === 'Q4_K_M' ? 'recommended' : undefined].filter(Boolean).join(' · '));
      const choice = await ui.select(`Select quantization\n${details.id}`, choices);
      if (!choice) return;
      quantization = details.quantizations[choices.indexOf(choice)]?.name;
      if (!quantization) return;
    }
    const model = quantization ? `${details.id}:${quantization}` : details.id;
    const result = await ui.progress({ title: 'Downloading model', model, cancelTitle: 'Stop download?',
      run: (progressSignal, update) => client.downloadAndWait(model, update, progressSignal),
      cancel: () => client.unload(model, timeout()) });
    signal.throwIfAborted();
    if (!result.cancelled) { await sync(result.value); ctx.ui.notify(`Downloaded ${model}`); }
  };
  let catalog = await read();
  while (catalog) {
    const action = await ui.models(server, catalog);
    signal.throwIfAborted();
    if (action.type === 'close') return;
    let failure: unknown;
    try {
      if (action.type === 'download') await download();
      else if (loaded(action.model)) {
        if (await ui.confirm('Unload model?', action.model.id)) {
          signal.throwIfAborted(); await client.unloadAndWait(action.model.id, signal); await sync(); ctx.ui.notify(`Unloaded ${action.model.id}`);
        }
      } else if (action.model.status.value === 'unloaded') await load(catalog, action.model);
      else ctx.ui.notify(`${action.model.id} is ${action.model.status.value}`, 'warning');
    } catch (error) { signal.throwIfAborted(); failure = error; }
    catalog = await read();
    if (failure && !connectionError(failure)) ctx.ui.notify(safeMessage(failure), 'error');
  }
}
