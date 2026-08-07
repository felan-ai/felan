import { describe, expect, it } from 'vitest';
import {
  getRtkOptimizerConfigPath,
  loadRtkOptimizerConfig,
  RTK_OPTIMIZER_CONFIG_FILE,
  saveRtkOptimizerConfig,
  validateRtkOptimizerConfig,
} from '../src/config.js';
import { DEFAULT_RTK_OPTIMIZER_CONFIG } from '../src/types.js';
import { MemoryRuntime } from './test-runtime.js';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

describe('RTK optimizer configuration', () => {
  it('creates and returns safe defaults when the config is missing', async () => {
    const runtime = new MemoryRuntime();

    const loaded = await loadRtkOptimizerConfig(runtime);

    expect(loaded).toEqual({ config: DEFAULT_RTK_OPTIMIZER_CONFIG });
    expect(loaded.config).not.toBe(DEFAULT_RTK_OPTIMIZER_CONFIG);
    expect(JSON.parse(decoder.decode(runtime.files.get(RTK_OPTIMIZER_CONFIG_FILE)))).toEqual(
      DEFAULT_RTK_OPTIMIZER_CONFIG,
    );
    expect(getRtkOptimizerConfigPath(runtime)).toBe('/agent-storage/rtk-optimizer/config.json');
  });

  it('merges partial files with defaults and persists validated updates', async () => {
    const runtime = new MemoryRuntime();
    runtime.files.set(
      RTK_OPTIMIZER_CONFIG_FILE,
      encoder.encode(JSON.stringify({ mode: 'suggest', outputCompaction: { stripAnsi: false } })),
    );

    const loaded = await loadRtkOptimizerConfig(runtime);
    expect(loaded.config.mode).toBe('suggest');
    expect(loaded.config.outputCompaction.stripAnsi).toBe(false);
    expect(loaded.config.outputCompaction.readCompaction.enabled).toBe(false);

    loaded.config.outputCompaction.truncate.maxChars = 20_000;
    await saveRtkOptimizerConfig(runtime, loaded.config);
    expect(JSON.parse(decoder.decode(runtime.files.get(RTK_OPTIMIZER_CONFIG_FILE)))).toMatchObject({
      outputCompaction: { truncate: { maxChars: 20_000 } },
    });
  });

  it('rejects unknown, mistyped, and out-of-range fields', () => {
    expect(() => validateRtkOptimizerConfig({ surprise: true })).toThrow('contains unknown field: surprise');
    expect(() => validateRtkOptimizerConfig({ enabled: 'yes' })).toThrow('.enabled must be a boolean');
    expect(() => validateRtkOptimizerConfig({ mode: 'automatic' })).toThrow('.mode must be rewrite, or suggest');
    expect(() =>
      validateRtkOptimizerConfig({
        outputCompaction: { truncate: { maxChars: 999 } },
      }),
    ).toThrow('must be an integer from 1000 to 200000');
  });

  it('uses defaults and preserves an invalid user file', async () => {
    const runtime = new MemoryRuntime();
    const invalid = encoder.encode('{ not json');
    runtime.files.set(RTK_OPTIMIZER_CONFIG_FILE, invalid);

    const loaded = await loadRtkOptimizerConfig(runtime);

    expect(loaded.config).toEqual(DEFAULT_RTK_OPTIMIZER_CONFIG);
    expect(loaded.warning).toContain('Invalid /agent-storage/rtk-optimizer/config.json');
    expect(runtime.files.get(RTK_OPTIMIZER_CONFIG_FILE)).toEqual(invalid);
  });
});
