import { createHash } from 'node:crypto';
import type { AgentRuntime, SavingsModelReference } from '@felan-ai/agent-core';
import { isWindowsRuntimePath, joinRuntimePath } from './runtime-path.js';

const GAIN_DIRECTORY = 'rtk-optimizer/gain';
const CAPTURE_PATTERN = /^(\d{13})-[0-9a-f-]{36}\.db(?:-(?:wal|shm|journal))?$/u;
const SEGMENT_MANIFEST_PATTERN = /^([0-9a-f]{64})\.json$/u;
const SEGMENT_DATABASE_PATTERN = /^([0-9a-f]{64})\.db(?:-(?:wal|shm|journal))?$/u;
const MAX_CAPTURE_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_GAIN_FILES = 512;
const MAX_GAIN_SEGMENTS = 64;
const MAX_GAIN_OUTPUT_BYTES = 64 * 1_024;
const MAX_MANIFEST_BYTES = 1_024;
const GAIN_TIMEOUT_MS = 5_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface RtkGainTotals {
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface RtkGainSegment {
  readonly key: string;
  readonly relativeDatabasePath: string;
  readonly databasePath: string;
  readonly relativeManifestPath: string;
  readonly model: SavingsModelReference | undefined;
}

interface RtkGainSegmentManifest {
  readonly version: 1;
  readonly updatedAt: number;
  readonly provider?: string;
  readonly model?: string;
}

interface SegmentOptions {
  readonly now?: () => number;
}

export async function createRtkGainSegment(
  runtime: AgentRuntime,
  model: SavingsModelReference | undefined,
  options: SegmentOptions = {},
): Promise<RtkGainSegment | undefined> {
  const storage = runtime.storage('session');
  if (isWindowsRuntimePath(storage.root) || !isValidModel(model)) return undefined;

  const segment = segmentFor(storage.root, model);
  const manifest: RtkGainSegmentManifest = {
    version: 1,
    updatedAt: options.now?.() ?? Date.now(),
    ...(model === undefined ? {} : { provider: model.provider, model: model.id }),
  };
  const bytes = encoder.encode(JSON.stringify(manifest));
  if (bytes.byteLength > MAX_MANIFEST_BYTES) return undefined;

  try {
    await storage.mkdir(GAIN_DIRECTORY, { recursive: true });
    await pruneStaleRtkGainCaptures(runtime, options.now?.() ?? Date.now()).catch(() => {});
    await storage.writeFile(segment.relativeManifestPath, bytes);
    return segment;
  } catch {
    return undefined;
  }
}

export async function discoverRtkGainSegments(runtime: AgentRuntime): Promise<RtkGainSegment[]> {
  const storage = runtime.storage('session');
  if (isWindowsRuntimePath(storage.root)) return [];

  let entries: string[];
  try {
    entries = await storage.listFiles(GAIN_DIRECTORY, { limit: MAX_GAIN_FILES });
  } catch {
    return [];
  }

  const names = entries.map(fileName);
  const databaseKeys = new Set(names.flatMap((name) => {
    const match = SEGMENT_DATABASE_PATTERN.exec(name);
    return match ? [match[1]!] : [];
  }));
  const retainedKeys = new Set<string>();
  const segments: RtkGainSegment[] = [];

  for (const name of names) {
    const match = SEGMENT_MANIFEST_PATTERN.exec(name);
    if (!match) continue;
    const key = match[1]!;
    const relativeManifestPath = joinRuntimePath(GAIN_DIRECTORY, name);
    let manifest: RtkGainSegmentManifest | undefined;
    try {
      const bytes = await storage.readFile(relativeManifestPath, { maxBytes: MAX_MANIFEST_BYTES });
      manifest = parseSegmentManifest(decoder.decode(bytes));
    } catch {
      await discardSegmentKey(runtime, key);
      continue;
    }

    const model = modelFromManifest(manifest);
    if (!manifest || !isValidModel(model) || segmentKey(model) !== key) {
      await discardSegmentKey(runtime, key);
      continue;
    }
    if (Date.now() - manifest.updatedAt > MAX_CAPTURE_AGE_MS) {
      await discardSegmentKey(runtime, key);
      continue;
    }
    retainedKeys.add(key);
    if (segments.length >= MAX_GAIN_SEGMENTS) {
      await discardSegmentKey(runtime, key);
      retainedKeys.delete(key);
      continue;
    }
    segments.push(segmentFor(storage.root, model));
  }

  await Promise.allSettled([...databaseKeys]
    .filter((key) => !retainedKeys.has(key))
    .map((key) => discardSegmentKey(runtime, key)));
  return segments;
}

export async function readRtkGainSegment(
  runtime: AgentRuntime,
  executable: string,
  segment: RtkGainSegment,
): Promise<RtkGainTotals | undefined> {
  return readRtkGainDatabase(runtime, executable, segment.databasePath);
}

export async function discardRtkGainSegment(
  runtime: AgentRuntime,
  segment: RtkGainSegment,
): Promise<void> {
  await discardSegmentKey(runtime, segment.key);
}

export function wrapCommandWithRtkGain(command: string, capture: RtkGainSegment): string {
  return `(RTK_DB_PATH=${quotePosixShellArgument(capture.databasePath)}; export RTK_DB_PATH; ${command}\n\n)`;
}

export function parseRtkGainSummary(value: string): RtkGainTotals | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  const summary = record(record(parsed).summary);
  const calls = safeCounter(summary.total_commands);
  const inputTokens = safeCounter(summary.total_input);
  const outputTokens = safeCounter(summary.total_output);
  const savedTokens = safeCounter(summary.total_saved);
  if (calls === undefined || inputTokens === undefined || outputTokens === undefined || savedTokens === undefined) {
    return undefined;
  }
  if (savedTokens !== Math.max(0, inputTokens - outputTokens)) return undefined;
  if (calls === 0 && (inputTokens !== 0 || outputTokens !== 0)) return undefined;
  return { calls, inputTokens, outputTokens };
}

async function pruneStaleCaptures(runtime: AgentRuntime, now: number): Promise<void> {
  const storage = runtime.storage('session');
  const entries = await storage.listFiles(GAIN_DIRECTORY, { limit: 512 });
  await Promise.allSettled(entries.flatMap((entry) => {
    const name = fileName(entry);
    const match = CAPTURE_PATTERN.exec(name);
    if (!match) return [];
    const createdAt = Number.parseInt(match[1]!, 10);
    if (!Number.isSafeInteger(createdAt) || now - createdAt <= MAX_CAPTURE_AGE_MS) return [];
    return [storage.remove(joinRuntimePath(GAIN_DIRECTORY, name))];
  }));
}

async function pruneStaleRtkGainCaptures(runtime: AgentRuntime, now: number): Promise<void> {
  await pruneStaleCaptures(runtime, now);
  const storage = runtime.storage('session');
  let entries: string[];
  try {
    entries = await storage.listFiles(GAIN_DIRECTORY, { limit: MAX_GAIN_FILES });
  } catch {
    return;
  }
  await Promise.allSettled(entries.map(async (entry) => {
    const match = SEGMENT_MANIFEST_PATTERN.exec(fileName(entry));
    if (!match) return;
    try {
      const manifest = parseSegmentManifest(decoder.decode(await storage.readFile(entry, { maxBytes: MAX_MANIFEST_BYTES })));
      if (!manifest || now - manifest.updatedAt > MAX_CAPTURE_AGE_MS) await discardSegmentKey(runtime, match[1]!);
    } catch {
      await discardSegmentKey(runtime, match[1]!);
    }
  }));
}

function segmentFor(storageRoot: string, model: SavingsModelReference | undefined): RtkGainSegment {
  const key = segmentKey(model);
  const relativeDatabasePath = joinRuntimePath(GAIN_DIRECTORY, `${key}.db`);
  return {
    key,
    relativeDatabasePath,
    databasePath: joinRuntimePath(storageRoot, relativeDatabasePath),
    relativeManifestPath: joinRuntimePath(GAIN_DIRECTORY, `${key}.json`),
    model,
  };
}

function segmentKey(model: SavingsModelReference | undefined): string {
  return createHash('sha256')
    .update(model === undefined ? 'unknown' : `${model.provider}\0${model.id}`, 'utf8')
    .digest('hex');
}

function modelFromManifest(manifest: RtkGainSegmentManifest | undefined): SavingsModelReference | undefined {
  if (!manifest || manifest.provider === undefined || manifest.model === undefined) return undefined;
  return { provider: manifest.provider, id: manifest.model };
}

function parseSegmentManifest(value: string): RtkGainSegmentManifest | undefined {
  try {
    const parsed = record(JSON.parse(value));
    if (parsed.version !== 1) return undefined;
    if (!safeTimestamp(parsed.updatedAt)) return undefined;
    const provider = parsed.provider;
    const model = parsed.model;
    if (provider !== undefined && typeof provider !== 'string') return undefined;
    if (model !== undefined && typeof model !== 'string') return undefined;
    if ((provider === undefined) !== (model === undefined)) return undefined;
    return {
      version: 1,
      updatedAt: parsed.updatedAt,
      ...(provider === undefined ? {} : { provider, model: model as string }),
    };
  } catch {
    return undefined;
  }
}

function isValidModel(model: SavingsModelReference | undefined): boolean {
  return model === undefined
    || (isBoundedLabel(model.provider, 64) && isBoundedLabel(model.id, 128));
}

function isBoundedLabel(value: string, maximum: number): boolean {
  return value.length > 0 && value.length <= maximum && !/[\u0000\r\n]/u.test(value);
}

function safeTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

async function readRtkGainDatabase(
  runtime: AgentRuntime,
  executable: string,
  databasePath: string,
): Promise<RtkGainTotals | undefined> {
  try {
    const result = await runtime.exec('/usr/bin/env', [
      `RTK_DB_PATH=${databasePath}`,
      executable,
      'gain',
      '--format',
      'json',
    ], {
      timeout: GAIN_TIMEOUT_MS,
      maxOutputBytes: MAX_GAIN_OUTPUT_BYTES,
    });
    if (result.killed || result.code !== 0 || result.truncated) return undefined;
    return parseRtkGainSummary(result.stdout);
  } catch {
    return undefined;
  }
}

async function discardSegmentKey(runtime: AgentRuntime, key: string): Promise<void> {
  const storage = runtime.storage('session');
  await Promise.allSettled(
    ['', '-wal', '-shm', '-journal', '.json'].map((suffix) => storage.remove(
      suffix === '.json'
        ? joinRuntimePath(GAIN_DIRECTORY, `${key}.json`)
        : joinRuntimePath(GAIN_DIRECTORY, `${key}.db${suffix}`),
    )),
  );
}

function quotePosixShellArgument(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

function safeCounter(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function fileName(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}
