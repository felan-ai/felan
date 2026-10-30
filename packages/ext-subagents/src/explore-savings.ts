import type {
  AgentRuntimeStorage,
  FelanExtensionAPI,
  SavingsModelReference,
  SessionExecution,
  SessionsService,
} from '@felan-ai/agent-core';

type Usage = NonNullable<SessionExecution['usage']>;
interface Entry {
  readonly executionId: string;
  parentModel?: SavingsModelReference;
  usage?: Usage;
}

const directory = 'savings/explore-routing';
const maxBytes = 4 * 1024;
const usageKeys = ['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h', 'cost'] as const;
const encoder = new TextEncoder();

export function registerExploreRoutingSavings(pi: FelanExtensionAPI, sessions: SessionsService) {
  if (!pi.runtime || !pi.savings) return;
  let storage: AgentRuntimeStorage;
  try { storage = pi.runtime.storage('session'); } catch { return; }
  const reporter = pi.savings;
  const entries = new Map<string, Entry>();
  let queue = Promise.resolve();
  let unsubscribe: (() => void) | undefined;
  let started = false;
  let closed = false;
  let scheduled = false;

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation);
    queue = result.then(() => {}, () => {});
    return result;
  }

  async function settle() {
    let current: Promise<void>;
    do { current = queue; await current; } while (current !== queue);
  }

  function path(id: string) { return `${directory}/${encodeURIComponent(id)}.json`; }

  async function entryFor(id: string): Promise<Entry> {
    const existing = entries.get(id);
    if (existing) return existing;
    let entry: Entry = { executionId: id };
    try {
      const bytes = await storage.readFile(path(id), { maxBytes });
      if (bytes.byteLength <= maxBytes) {
        const data: unknown = JSON.parse(new TextDecoder().decode(bytes));
        if (isObject(data) && data.version === 1 && isEntry(data.entry) && data.entry.executionId === id) entry = data.entry;
      }
    } catch {}
    entries.set(id, entry);
    return entry;
  }

  async function persist(entry: Entry) {
    try {
      const bytes = encoder.encode(JSON.stringify({ version: 1, entry }));
      if (bytes.byteLength > maxBytes) return;
      await storage.mkdir(directory, { recursive: true });
      await storage.writeFile(path(entry.executionId), bytes);
    } catch {}
  }

  function subscribe() {
    if (unsubscribe || closed) return;
    try {
      unsubscribe = sessions.subscribe(event => {
        if (closed || event.kind !== 'execution' || scheduled) return;
        scheduled = true;
        void enqueue(async () => { scheduled = false; await reconcile(); }).catch(() => {});
      });
    } catch {}
  }

  async function observe(record: SessionExecution) {
    if (record.label !== 'explore' || !validId(record.id)) return;
    subscribe();
    if (record.state === 'queued' || record.state === 'running' || !isUsage(record.usage)) return;
    const entry = await entryFor(record.id);
    const current = { ...record.usage };
    const usage = Object.fromEntries(usageKeys.map(key => [key, current[key] - (entry.usage?.[key] ?? 0)])) as Usage;
    if (usageKeys.every(key => current[key] === entry.usage?.[key])) return;
    entry.usage = current;
    await persist(entry);
    if (record.state !== 'completed' || !record.result?.text.trim() || !entry.parentModel || !isModel(record.model)
      || sameModel(entry.parentModel, record.model) || usageKeys.some(key => usage[key] < 0)) return;
    const { cost, ...tokens } = usage;
    if (Object.values(tokens).reduce((total, value) => total + value, 0) <= 0) return;
    await reporter.report({
      category: 'model-routing', operation: 'explore-child',
      baseline: { model: entry.parentModel, tokens },
      actual: { model: { ...record.model }, tokens, ...(cost > 0 ? { costUsd: cost } : {}) },
      basis: { kind: 'estimated-baseline', method: 'parent-model-reprice-observed-child-usage-v1' },
      dimensions: { techniques: ['explore', 'same-usage-reprice'] },
    }).catch(() => {});
  }

  async function reconcile() {
    let cursor: string | undefined;
    do {
      const page = await sessions.executions({ includeDescendants: false, ...(cursor ? { cursor } : {}) });
      for (const record of page.items) await observe(record);
      cursor = page.nextCursor;
    } while (cursor);
  }

  pi.on('session_start', async () => {
    if (started || closed) return;
    started = true;
    await enqueue(reconcile).catch(() => {});
  });

  pi.on('session_shutdown', async () => {
    closed = true;
    try { unsubscribe?.(); } catch {}
    await settle();
  });

  return {
    settle,
    trackSpawn(model: SavingsModelReference, create: () => Promise<SessionExecution>): Promise<SessionExecution> {
      if (closed || !isModel(model)) return create();
      subscribe();
      const parentModel = { provider: model.provider, id: model.id };
      return enqueue(async () => {
        const execution = await create();
        if (validId(execution.id)) {
          const entry = await entryFor(execution.id);
          if (!entry.parentModel) {
            entry.parentModel = parentModel;
            await persist(entry);
          }
        }
        return execution;
      });
    },
  };
}

function sameModel(a: SavingsModelReference, b: SavingsModelReference) {
  return a.provider.toLowerCase() === b.provider.toLowerCase() && a.id.toLowerCase() === b.id.toLowerCase();
}
function isObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object'; }
function validId(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 128; }
function isModel(value: unknown): value is SavingsModelReference {
  return isObject(value) && [value.provider, value.id].every(part => typeof part === 'string' && part.length > 0 && part.length <= 256);
}
function isUsage(value: unknown): value is Usage {
  return isObject(value) && usageKeys.every(key => typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0);
}
function isEntry(value: unknown): value is Entry {
  return isObject(value) && validId(value.executionId)
    && (value.parentModel === undefined || isModel(value.parentModel)) && (value.usage === undefined || isUsage(value.usage));
}
