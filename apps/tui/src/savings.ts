import { randomUUID } from 'node:crypto';
import type {
  AgentRuntime,
  AgentRuntimeStorage,
  SavingsMeasurement,
  SavingsModelReference,
  SavingsOutcome,
  SavingsReporter,
  SavingsReporterProvider,
  SavingsTokenUsage,
} from '@felan-ai/agent-core';

export type {
  SavingsCategory,
  SavingsMeasurement,
  SavingsModelReference,
  SavingsOutcome,
  SavingsReporter,
  SavingsReporterProvider,
  SavingsTokenUsage,
} from '@felan-ai/agent-core';

export interface SavingsPrice {
  readonly model: SavingsModelReference;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly tiers?: readonly SavingsPriceTier[];
  readonly fingerprint: string;
}

export interface SavingsPriceTier {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly inputTokensAbove: number;
}

export interface SavingsPriceSource {
  resolveModel(model: SavingsModelReference): SavingsPrice | undefined | Promise<SavingsPrice | undefined>;
}

export interface SavingsServiceOptions {
  readonly runtime: AgentRuntime;
  readonly rootSessionId: string;
  readonly projectKey: string;
  readonly priceSource?: SavingsPriceSource;
  readonly now?: () => Date;
  readonly writerId?: string;
}

export type SavingsScope = 'session' | 'project' | 'all';

export interface SavingsQuery {
  readonly scope?: SavingsScope;
  readonly sessionId?: string;
  readonly projectKey?: string;
  readonly producerId?: string;
  readonly from?: Date;
  readonly to?: Date;
}

export interface SavingsTokenTotals {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cacheWrite1h: number;
}

export interface SavingsOutcomeTotals {
  readonly costUsd?: number;
  readonly model?: SavingsModelReference;
  readonly tokens?: SavingsTokenTotals;
  readonly priceSource: 'producer-reported' | 'model-catalog' | 'unavailable';
  readonly priceFingerprint?: string;
}

export interface SavingsBucket {
  readonly day: string;
  readonly sessionId: string;
  readonly projectKey: string;
  readonly producerId: string;
  readonly category: SavingsMeasurement['category'];
  readonly operation?: string;
  readonly basis: SavingsMeasurement['basis'];
  readonly tool?: string;
  readonly techniques?: readonly string[];
  readonly calls: number;
  readonly baseline: SavingsOutcomeTotals;
  readonly actual: SavingsOutcomeTotals;
}

export interface SavingsReport {
  readonly scope: SavingsScope;
  readonly bucketCount: number;
  readonly calls: number;
  readonly baselineCostUsd: number;
  readonly actualCostUsd: number;
  readonly savedCostUsd: number;
  readonly hasUnpricedMeasurements: boolean;
  readonly buckets: readonly SavingsBucket[];
  readonly diagnostics: readonly string[];
}

interface Snapshot {
  readonly version: 1;
  readonly writerId: string;
  readonly sequence: number;
  readonly updatedAt: string;
  readonly buckets: readonly SavingsBucket[];
}

const ROOT = 'savings/v1';
const WRITER_PATTERN = /^(?:savings\/v1\/)?writers\/([a-f0-9-]{36})\/(\d+)\.json$/u;
const MAX_BUCKETS = 2_000;
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const MAX_GENERATIONS = 4;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class SavingsService implements SavingsReporterProvider {
  readonly #storage: AgentRuntimeStorage;
  readonly #options: SavingsServiceOptions;
  readonly #writerId: string;
  readonly #buckets = new Map<string, SavingsBucket>();
  #sequence = 0;
  #queue = Promise.resolve();
  #persistenceErrors = 0;

  constructor(options: SavingsServiceOptions) {
    this.#options = options;
    this.#storage = options.runtime.storage('agent');
    this.#writerId = options.writerId ?? randomUUID();
    if (!/^[a-f0-9-]{36}$/u.test(this.#writerId)) throw new Error('writerId must be a UUID');
  }

  createReporter(producerId: string): SavingsReporter {
    if (!isProducerId(producerId)) throw new Error('producerId must be a bounded identifier');
    return {
      report: (measurement) => this.report(producerId, measurement),
    };
  }

  async report(producerId: string, measurement: SavingsMeasurement): Promise<void> {
    await this.#enqueue(async () => {
      const bucket = await this.#normalize(producerId, measurement);
      const key = bucketKey(bucket);
      const previous = this.#buckets.get(key);
      this.#buckets.set(key, previous ? mergeBuckets(previous, bucket) : bucket);
      while (this.#buckets.size > MAX_BUCKETS) this.#buckets.delete(this.#buckets.keys().next().value!);
      try {
        await this.#persist();
      } catch {
        this.#persistenceErrors += 1;
      }
    });
  }

  async query(query: SavingsQuery = {}): Promise<SavingsReport> {
    const snapshots = await readSnapshots(this.#storage);
    const own = [...this.#buckets.values()];
    const all = [
      ...snapshots.filter(({ snapshot }) => snapshot.writerId !== this.#writerId).flatMap(({ snapshot }) => snapshot.buckets),
      ...own,
    ];
    const selected = filterBuckets(all, query, this.#options.rootSessionId, this.#options.projectKey);
    const deduped = dedupeSnapshots(selected);
    const diagnostics = snapshots.flatMap(({ error }) => error === undefined ? [] : [error]);
    if (this.#persistenceErrors > 0) diagnostics.push(`${this.#persistenceErrors} savings writes failed`);
    const baseline = sumCost(deduped, 'baseline');
    const actual = sumCost(deduped, 'actual');
    return {
      scope: query.scope ?? (query.sessionId ? 'session' : query.projectKey ? 'project' : 'all'),
      bucketCount: deduped.length,
      calls: deduped.reduce((total, bucket) => total + bucket.calls, 0),
      baselineCostUsd: baseline.value,
      actualCostUsd: actual.value,
      savedCostUsd: baseline.value - actual.value,
      hasUnpricedMeasurements: baseline.unpriced || actual.unpriced,
      buckets: deduped,
      diagnostics,
    };
  }

  async #normalize(producerId: string, measurement: SavingsMeasurement): Promise<SavingsBucket> {
    validateMeasurement(producerId, measurement);
    const baseline = await resolveOutcome(measurement.baseline, this.#options.priceSource);
    const actual = await resolveOutcome(measurement.actual, this.#options.priceSource);
    const now = (this.#options.now ?? (() => new Date()))();
    return {
      day: now.toISOString().slice(0, 10),
      sessionId: this.#options.rootSessionId,
      projectKey: this.#options.projectKey,
      producerId,
      category: measurement.category,
      ...(measurement.operation === undefined ? {} : { operation: measurement.operation }),
      basis: measurement.basis,
      ...(measurement.dimensions?.tool === undefined ? {} : { tool: measurement.dimensions.tool }),
      ...(measurement.dimensions?.techniques === undefined ? {} : { techniques: measurement.dimensions.techniques }),
      calls: measurement.calls ?? 1,
      baseline,
      actual,
    };
  }

  async #persist(): Promise<void> {
    const snapshot: Snapshot = {
      version: 1,
      writerId: this.#writerId,
      sequence: ++this.#sequence,
      updatedAt: new Date().toISOString(),
      buckets: [...this.#buckets.values()],
    };
    const bytes = encoder.encode(JSON.stringify(snapshot));
    if (bytes.byteLength > MAX_SNAPSHOT_BYTES) throw new Error('Savings snapshot exceeds size limit');
    const directory = `${ROOT}/writers/${this.#writerId}`;
    await this.#storage.mkdir(directory, { recursive: true });
    await this.#storage.writeFile(`${directory}/${snapshot.sequence}.json`, bytes);
    const files = await this.#storage.listFiles(directory, { pattern: '*.json' });
    for (const file of files.sort((a, b) => Number.parseInt(a) - Number.parseInt(b)).slice(0, -MAX_GENERATIONS)) {
      await this.#storage.remove(`${directory}/${file}`);
    }
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#queue;
    const current = previous.then(operation);
    this.#queue = current.then(() => {}, () => {});
    return current;
  }
}

export function createModelPriceSource(
  resolveModel: (model: SavingsModelReference) => SavingsPrice | undefined,
): SavingsPriceSource {
  return { resolveModel };
}

export function formatSavingsReport(report: SavingsReport, detailed = false): string {
  const lines = [
    `Felan savings — ${report.scope}`,
    `Estimated cost avoided: ${formatUsd(report.savedCostUsd)}`,
    `Measured decisions: ${report.calls}`,
  ];
  if (report.hasUnpricedMeasurements) lines.push('Some measurements have unavailable pricing and are excluded from the USD total.');
  if (detailed) {
    for (const bucket of report.buckets) {
      lines.push(`- ${bucket.producerId}: ${bucket.category}${bucket.operation ? `/${bucket.operation}` : ''} ${formatUsd(cost(bucket.baseline) - cost(bucket.actual))} (${bucket.calls} calls)`);
    }
  }
  lines.push(...report.diagnostics.map((diagnostic) => `Warning: ${diagnostic}`));
  return lines.join('\n');
}

function validateMeasurement(producerId: string, measurement: SavingsMeasurement): void {
  if (!isProducerId(producerId) || !['output-optimization', 'model-routing', 'context-management', 'other'].includes(measurement.category)) throw new Error('Invalid savings category or producer');
  if (measurement.operation !== undefined && !isSlug(measurement.operation, 64)) throw new Error('Invalid savings operation');
  if (!measurement.basis || !['observed-comparison', 'estimated-baseline'].includes(measurement.basis.kind) || !isSlug(measurement.basis.method, 128)) throw new Error('Invalid savings basis');
  if (measurement.calls !== undefined && (!Number.isSafeInteger(measurement.calls) || measurement.calls < 1 || measurement.calls > 10_000)) throw new Error('Invalid savings call count');
  for (const outcome of [measurement.baseline, measurement.actual]) validateOutcome(outcome);
  for (const value of [measurement.dimensions?.tool, ...(measurement.dimensions?.techniques ?? [])]) {
    if (value !== undefined && !isSlug(value, 64)) throw new Error('Invalid savings dimension');
  }
  if ((measurement.dimensions?.techniques?.length ?? 0) > 16) throw new Error('Too many savings techniques');
}

function validateOutcome(outcome: SavingsOutcome): void {
  if (outcome.costUsd === undefined && outcome.tokens === undefined) throw new Error('Savings outcome needs cost or tokens');
  if (outcome.costUsd !== undefined && (!Number.isFinite(outcome.costUsd) || outcome.costUsd < 0)) throw new Error('Invalid savings cost');
  if (outcome.model && (!isSlug(outcome.model.provider, 64) || !isSlug(outcome.model.id, 128))) throw new Error('Invalid savings model');
  if (outcome.tokens) for (const value of Object.values(outcome.tokens)) if (value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)) throw new Error('Invalid savings tokens');
}

async function resolveOutcome(outcome: SavingsOutcome, source: SavingsPriceSource | undefined): Promise<SavingsOutcomeTotals> {
  const tokens = outcome.tokens === undefined ? undefined : totals(outcome.tokens);
  if (outcome.costUsd !== undefined) return { costUsd: outcome.costUsd, ...(outcome.model ? { model: outcome.model } : {}), ...(tokens === undefined ? {} : { tokens }), priceSource: 'producer-reported' };
  if (!source || !outcome.model || tokens === undefined) return { ...(outcome.model ? { model: outcome.model } : {}), ...(tokens === undefined ? {} : { tokens }), priceSource: 'unavailable' };
  const price = await source.resolveModel(outcome.model);
  if (!price) return { model: outcome.model, tokens, priceSource: 'unavailable' };
  return { costUsd: calculateCost(price, tokens), model: outcome.model, tokens, priceSource: 'model-catalog', priceFingerprint: price.fingerprint };
}

function calculateCost(price: SavingsPrice, tokens: SavingsTokenTotals): number {
  const inputTokens = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  let rates: SavingsPrice | SavingsPriceTier = price;
  let threshold = -1;
  for (const tier of price.tiers ?? []) if (inputTokens > tier.inputTokensAbove && tier.inputTokensAbove > threshold) {
    rates = tier;
    threshold = tier.inputTokensAbove;
  }
  const shortWrite = tokens.cacheWrite - tokens.cacheWrite1h;
  return rates.input * tokens.input / 1e6 + rates.output * tokens.output / 1e6 + rates.cacheRead * tokens.cacheRead / 1e6 + (rates.cacheWrite * shortWrite + rates.input * 2 * tokens.cacheWrite1h) / 1e6;
}

function totals(tokens: SavingsTokenUsage): SavingsTokenTotals {
  return { input: tokens.input, output: tokens.output, cacheRead: tokens.cacheRead ?? 0, cacheWrite: tokens.cacheWrite ?? 0, cacheWrite1h: tokens.cacheWrite1h ?? 0 };
}

function mergeBuckets(left: SavingsBucket, right: SavingsBucket): SavingsBucket {
  return { ...left, calls: left.calls + right.calls, baseline: mergeOutcome(left.baseline, right.baseline), actual: mergeOutcome(left.actual, right.actual) };
}

function mergeOutcome(left: SavingsOutcomeTotals, right: SavingsOutcomeTotals): SavingsOutcomeTotals {
  const tokens = left.tokens && right.tokens ? Object.fromEntries(Object.keys(left.tokens).map((key) => [key, (left.tokens as unknown as Record<string, number>)[key]! + (right.tokens as unknown as Record<string, number>)[key]!])) as unknown as SavingsTokenTotals : undefined;
  return { ...(left.costUsd === undefined || right.costUsd === undefined ? {} : { costUsd: left.costUsd + right.costUsd }), ...(left.model ? { model: left.model } : {}), ...(tokens ? { tokens } : {}), priceSource: left.priceSource, ...(left.priceFingerprint ? { priceFingerprint: left.priceFingerprint } : {}) };
}

function bucketKey(bucket: SavingsBucket): string {
  return JSON.stringify([bucket.day, bucket.sessionId, bucket.projectKey, bucket.producerId, bucket.category, bucket.operation, bucket.basis, bucket.tool, bucket.techniques, bucket.baseline.model, bucket.baseline.priceSource, bucket.baseline.priceFingerprint, bucket.actual.model, bucket.actual.priceSource, bucket.actual.priceFingerprint]);
}

function filterBuckets(buckets: readonly SavingsBucket[], query: SavingsQuery, sessionId: string, projectKey: string): SavingsBucket[] {
  const scope = query.scope ?? (query.sessionId ? 'session' : query.projectKey ? 'project' : 'all');
  return buckets.filter((bucket) => (scope !== 'session' || bucket.sessionId === (query.sessionId ?? sessionId)) && (scope !== 'project' || bucket.projectKey === (query.projectKey ?? projectKey)) && (query.producerId === undefined || bucket.producerId === query.producerId) && (query.from === undefined || bucket.day >= query.from.toISOString().slice(0, 10)) && (query.to === undefined || bucket.day <= query.to.toISOString().slice(0, 10)));
}

function dedupeSnapshots(buckets: readonly SavingsBucket[]): SavingsBucket[] {
  const result = new Map<string, SavingsBucket>();
  for (const bucket of buckets) result.set(bucketKey(bucket), result.has(bucketKey(bucket)) ? mergeBuckets(result.get(bucketKey(bucket))!, bucket) : bucket);
  return [...result.values()];
}

function sumCost(buckets: readonly SavingsBucket[], side: 'baseline' | 'actual'): { value: number; unpriced: boolean } {
  let value = 0; let unpriced = false;
  for (const bucket of buckets) { const outcome = bucket[side]; if (outcome.costUsd === undefined) unpriced = true; else value += outcome.costUsd; }
  return { value, unpriced };
}

function cost(outcome: SavingsOutcomeTotals): number { return outcome.costUsd ?? 0; }
function formatUsd(value: number): string { return `${value < 0 ? '-' : ''}$${Math.abs(value).toFixed(2)}`; }
function isSlug(value: string, max: number): boolean { return value.length > 0 && value.length <= max && /^[a-z0-9][a-z0-9._/-]*$/u.test(value); }
function isProducerId(value: string): boolean { return value.length > 0 && value.length <= 128 && /^[A-Za-z0-9@][A-Za-z0-9@._/-]*$/u.test(value); }

async function readSnapshots(storage: AgentRuntimeStorage): Promise<Array<{ snapshot: Snapshot; error?: string }>> {
  let files: string[];
  try { files = await storage.listFiles(ROOT, { recursive: true, pattern: '*.json', limit: 10_000 }); } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return [];
    return [{ snapshot: emptySnapshot(), error: `Unable to read savings storage: ${errorMessage(error)}` }];
  }
  const generations = new Map<string, Array<{ path: string; sequence: number }>>();
  for (const path of files) {
    const match = WRITER_PATTERN.exec(path.replaceAll('\\', '/'));
    if (!match) continue;
    const entries = generations.get(match[1]!) ?? [];
    entries.push({ path, sequence: Number(match[2]) });
    generations.set(match[1]!, entries);
  }
  const results: Array<{ snapshot: Snapshot; error?: string }> = [];
  for (const entries of generations.values()) {
    entries.sort((a, b) => b.sequence - a.sequence);
    let invalid = false;
    for (const { path } of entries) {
      try {
        const storagePath = path.startsWith(`${ROOT}/`) ? path : `${ROOT}/${path}`;
        const value: unknown = JSON.parse(decoder.decode(await storage.readFile(storagePath, { maxBytes: MAX_SNAPSHOT_BYTES })));
        if (!isSnapshot(value)) throw new Error('invalid snapshot');
        results.push({ snapshot: value, ...(invalid ? { error: 'Latest savings snapshot was invalid; used a fallback generation' } : {}) });
        break;
      } catch {
        invalid = true;
      }
    }
    if (invalid) {
      const writerId = WRITER_PATTERN.exec(entries[0]!.path.replaceAll('\\', '/'))?.[1];
      if (!results.some(({ snapshot }) => snapshot.writerId === writerId)) results.push({ snapshot: emptySnapshot(), error: 'All savings snapshot generations were invalid' });
    }
  }
  return results;
}

function isSnapshot(value: unknown): value is Snapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Snapshot;
  return snapshot.version === 1
    && typeof snapshot.writerId === 'string'
    && /^[a-f0-9-]{36}$/u.test(snapshot.writerId)
    && Number.isSafeInteger(snapshot.sequence)
    && snapshot.sequence >= 1
    && typeof snapshot.updatedAt === 'string'
    && Array.isArray(snapshot.buckets)
    && snapshot.buckets.length <= MAX_BUCKETS
    && snapshot.buckets.every(isPersistedBucket);
}

function isPersistedBucket(value: unknown): value is SavingsBucket {
  if (!value || typeof value !== 'object') return false;
  const bucket = value as SavingsBucket;
  if (typeof bucket.day !== 'string' || typeof bucket.sessionId !== 'string' || typeof bucket.projectKey !== 'string') return false;
  try {
    validateMeasurement(bucket.producerId, {
      category: bucket.category,
      ...(bucket.operation === undefined ? {} : { operation: bucket.operation }),
      baseline: bucket.baseline,
      actual: bucket.actual,
      basis: bucket.basis,
      calls: bucket.calls,
      dimensions: {
        ...(bucket.tool === undefined ? {} : { tool: bucket.tool }),
        ...(bucket.techniques === undefined ? {} : { techniques: bucket.techniques }),
      },
    });
  } catch { return false; }
  return isSlug(bucket.day, 10) && isSlug(bucket.sessionId, 128) && isSlug(bucket.projectKey, 128);
}
function emptySnapshot(): Snapshot { return { version: 1, writerId: randomUUID(), sequence: 0, updatedAt: new Date(0).toISOString(), buckets: [] }; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
