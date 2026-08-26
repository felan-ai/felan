import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostAgentRuntime } from '@felan-ai/agent-core';
import { describe, expect, it } from 'vitest';
import { SavingsService, createModelPriceSource, formatSavingsReport } from '../src/savings.js';
import { TestAgentRuntime } from '../../../packages/agent-core/test/test-agent-runtime.js';

describe('SavingsService', () => {
  it('persists producer buckets and reports lower cost with higher token usage', async () => {
    const runtime = new TestAgentRuntime('/workspace');
    const service = new SavingsService({
      runtime,
      rootSessionId: 'session-a',
      projectKey: 'project-a',
      now: () => new Date('2026-03-10T12:00:00Z'),
    });

    await service.createReporter('prewalk').report({
      category: 'model-routing',
      operation: 'delegate',
      baseline: { costUsd: 2, tokens: { input: 10, output: 10 } },
      actual: { costUsd: 1, tokens: { input: 20, output: 20 } },
      basis: { kind: 'estimated-baseline', method: 'counterfactual-v1' },
    });

    const report = await service.query({ scope: 'session' });
    expect(report.savedCostUsd).toBe(1);
    expect(report.buckets[0]).toMatchObject({ producerId: 'prewalk', calls: 1 });
    expect(report.buckets[0]?.actual.tokens).toMatchObject({ input: 20, output: 20 });
    expect(formatSavingsReport(report, true)).toContain('prewalk');
  });

  it('resolves tiered catalog pricing and keeps cache classes', async () => {
    const runtime = new TestAgentRuntime();
    const service = new SavingsService({
      runtime,
      rootSessionId: 'session-a',
      projectKey: 'project-a',
      priceSource: createModelPriceSource(() => ({
        model: { provider: 'test', id: 'cheap' },
        input: 1,
        output: 2,
        cacheRead: 0.5,
        cacheWrite: 3,
        tiers: [{ input: 0.5, output: 1, cacheRead: 0.25, cacheWrite: 1, inputTokensAbove: 100 }],
        fingerprint: 'price-1',
      })),
    });
    await service.report('optimizer', {
      category: 'output-optimization',
      baseline: { model: { provider: 'test', id: 'cheap' }, tokens: { input: 200, output: 0, cacheRead: 4, cacheWrite: 2, cacheWrite1h: 1 } },
      actual: { model: { provider: 'test', id: 'cheap' }, tokens: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 } },
      basis: { kind: 'estimated-baseline', method: 'test' },
    });
    const report = await service.query();
    expect(report.baselineCostUsd).toBeCloseTo((200 * .5 + 4 * .25 + 1 * 1 + 1 * .5 * 2) / 1e6);
    expect(report.buckets[0]?.baseline.priceFingerprint).toBe('price-1');
  });

  it('formats detailed savings as a table grouped by category and extension', async () => {
    const service = new SavingsService({
      runtime: new TestAgentRuntime(), rootSessionId: 'session-a', projectKey: 'project-a',
    });
    await service.report('optimizer', {
      category: 'output-optimization',
      operation: 'first-stage',
      baseline: { costUsd: 1 },
      actual: { costUsd: 0.5 },
      basis: { kind: 'observed-comparison', method: 'test' },
    });
    await service.report('optimizer', {
      category: 'output-optimization',
      operation: 'second-stage',
      baseline: { costUsd: 2 },
      actual: { costUsd: 1.25 },
      basis: { kind: 'observed-comparison', method: 'test' },
      calls: 2,
    });

    const output = formatSavingsReport(await service.query(), true);
    const rows = output.split('\n').filter((line) => line.includes('optimizer'));

    expect(output).toContain('Category');
    expect(output).toContain('Extension');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatch(/^Output optimization\s+optimizer\s+3\s+\$1\.25$/u);
    expect(output).not.toContain('first-stage');
    expect(output).not.toContain('second-stage');
  });

  it('keeps unavailable pricing out of the USD total', async () => {
    const service = new SavingsService({
      runtime: new TestAgentRuntime(), rootSessionId: 'session-a', projectKey: 'project-a',
    });
    await service.report('unknown', {
      category: 'other',
      baseline: { model: { provider: 'missing', id: 'model' }, tokens: { input: 5, output: 0 } },
      actual: { model: { provider: 'missing', id: 'model' }, tokens: { input: 1, output: 0 } },
      basis: { kind: 'estimated-baseline', method: 'test' },
    });
    const report = await service.query();
    expect(report.savedCostUsd).toBe(0);
    expect(report.hasUnpricedMeasurements).toBe(true);
    expect(report.buckets[0]?.baseline.priceSource).toBe('unavailable');
  });

  it('separates producers and scopes project queries', async () => {
    const runtime = new TestAgentRuntime();
    const first = new SavingsService({ runtime, rootSessionId: 's1', projectKey: 'p1', writerId: '11111111-1111-4111-8111-111111111111' });
    const second = new SavingsService({ runtime, rootSessionId: 's2', projectKey: 'p2', writerId: '22222222-2222-4222-8222-222222222222' });
    const measurement = { category: 'other' as const, baseline: { costUsd: 2 }, actual: { costUsd: 1 }, basis: { kind: 'observed-comparison' as const, method: 'test' } };
    await first.report('one', measurement);
    await second.report('two', measurement);
    expect((await first.query({ scope: 'project', projectKey: 'p1' })).buckets.map((bucket) => bucket.producerId)).toEqual(['one']);
    expect((await first.query({ scope: 'all' })).buckets.map((bucket) => bucket.producerId).sort()).toEqual(['one', 'two']);
  });

  it('loads nested writer snapshots from host storage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'felan-savings-'));
    try {
      const sessionStorageRoot = join(root, 'session');
      const agentStorageRoot = join(root, 'agent');
      await Promise.all([
        mkdir(sessionStorageRoot, { recursive: true }),
        mkdir(agentStorageRoot, { recursive: true }),
      ]);
      const runtime = new HostAgentRuntime(root, {
        sessionStorageRoot,
        agentStorageRoot,
        agentDir: root,
        pathAccess: 'host',
      });
      const first = new SavingsService({
        runtime,
        rootSessionId: 'session-a',
        projectKey: 'project-a',
        writerId: '11111111-1111-4111-8111-111111111111',
      });
      await first.report('optimizer', {
        category: 'output-optimization',
        baseline: { costUsd: 1 },
        actual: { costUsd: 0.25 },
        basis: { kind: 'observed-comparison', method: 'host-storage-test' },
      });

      const reloaded = new SavingsService({
        runtime,
        rootSessionId: 'session-b',
        projectKey: 'project-a',
        writerId: '22222222-2222-4222-8222-222222222222',
      });
      const report = await reloaded.query({ scope: 'all' });

      expect(report.calls).toBe(1);
      expect(report.savedCostUsd).toBe(0.75);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects invalid measurements', async () => {
    const service = new SavingsService({ runtime: new TestAgentRuntime(), rootSessionId: 's', projectKey: 'p' });
    await expect(service.report('bad producer!', {
      category: 'other', baseline: { costUsd: 1 }, actual: { costUsd: 0 },
      basis: { kind: 'observed-comparison', method: 'test' },
    })).rejects.toThrow('Invalid savings category or producer');
  });

  it('serializes concurrent reports and falls back from a corrupt latest generation', async () => {
    const runtime = new TestAgentRuntime();
    const writerId = '33333333-3333-4333-8333-333333333333';
    const service = new SavingsService({ runtime, rootSessionId: 's', projectKey: 'p', writerId });
    const measurement = (costUsd: number) => ({
      category: 'other' as const,
      baseline: { costUsd },
      actual: { costUsd: 0 },
      basis: { kind: 'observed-comparison' as const, method: 'test' },
    });
    await Promise.all([service.report('one', measurement(2)), service.report('one', measurement(3))]);
    expect((await service.query()).calls).toBe(2);
    await runtime.storage('agent').writeFile(`savings/v1/writers/${writerId}/2.json`, new TextEncoder().encode('{broken'));
    const recovered = new SavingsService({ runtime, rootSessionId: 's', projectKey: 'p', writerId: '44444444-4444-4444-8444-444444444444' });
    const report = await recovered.query();
    expect(report.calls).toBe(1);
    expect(report.diagnostics).toContain('Latest savings snapshot was invalid; used a fallback generation');
  });
});
