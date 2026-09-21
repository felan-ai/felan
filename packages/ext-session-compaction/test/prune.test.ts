import { describe, expect, it, vi } from 'vitest';
import { pruneEvidence } from '../src/prune.js';
import type { CompactionClassifierChoiceAnswer } from '../src/classifier.js';
import type { EvidenceBundle, EvidenceItem, PreparedSpan } from '../src/internal/contracts.js';

const bulky = (label: string): string => `${label} ${'x'.repeat(120)}`;

describe('Jev evidence prune', () => {
  it('drops obsolete observations and keeps failures and prefix evidence', async () => {
    const evidence = bundle([
      item('req', { kind: 'request', status: 'requested', text: 'Fix login', sourceId: 'user-1' }),
      item('call', { kind: 'tool-call', status: 'requested', text: 'grep {"pattern":"login"}', sourceId: 'hist-1', toolCallId: 'call-1', toolName: 'grep' }),
      item('obs', { kind: 'observation', status: 'observed', text: bulky('obsolete-output'), sourceId: 'hist-2', toolCallId: 'call-1', toolName: 'grep' }),
      item('err', { kind: 'error', status: 'failed', text: bulky('bash failed'), sourceId: 'hist-3', toolCallId: 'call-2', toolName: 'bash' }),
      item('prefix', { kind: 'observation', status: 'observed', text: bulky('prefix-output'), sourceId: 'prefix-1', toolCallId: 'call-3', toolName: 'grep' }),
    ]);
    const evaluate = vi.fn(async (_state: unknown, _questions: Record<string, unknown>) => ({
      answers: {
        e1: choice('obsolete', { exact_contents: 0.05, outcome_only: 0.1, obsolete: 0.85 }, 0.8),
      },
    }));
    const result = await pruneEvidence(evidence, span(['prefix-1']), { evaluate }, { trigger: 'manual' });

    expect(result.report).toMatchObject({ status: 'ran', kept: 0, shortened: 0, dropped: 1, asked: 1 });
    expect(result.evidence.items.map((entry) => entry.id)).toEqual(['req', 'err', 'prefix']);
    expect(evaluate.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      trigger: expect.stringContaining('Manual compaction'),
      goal: ['Fix login'],
      history: expect.arrayContaining([
        expect.objectContaining({ role: 'user', text: 'Fix login' }),
        expect.objectContaining({ id: 'e1', call: 'grep {"pattern":"login"}' }),
      ]),
      current_turn: [expect.objectContaining({ kind: 'observation' })],
    }));
    expect(evaluate.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      e1: expect.objectContaining({
        type: 'choice',
        instructions: expect.stringContaining('History item e1'),
      }),
    }));
  });

  it('shortens results that are only needed as outcomes', async () => {
    const evidence = bundle([
      item('obs', { kind: 'observation', status: 'observed', text: bulky('n'.repeat(400)), sourceId: 'hist-1', toolCallId: 'call-1', toolName: 'grep' }),
    ]);
    const result = await pruneEvidence(evidence, span(), {
      evaluate: async () => ({
        answers: {
          e1: choice('outcome_only', { exact_contents: 0.1, outcome_only: 0.8, obsolete: 0.1 }, 0.7),
        },
      }),
    }, { trigger: 'manual' });
    expect(result.report).toMatchObject({ status: 'ran', shortened: 1, dropped: 0 });
    expect(result.evidence.items[0]?.text).toContain('[jev: shortened');
  });

  it('keeps exact contents when that probability clears the keep bar', async () => {
    const evidence = bundle([
      item('obs', { kind: 'observation', status: 'observed', text: bulky('keep-me'), sourceId: 'hist-1', toolCallId: 'call-1' }),
    ]);
    const result = await pruneEvidence(evidence, span(), {
      evaluate: async () => ({
        answers: {
          e1: choice('outcome_only', { exact_contents: 0.4, outcome_only: 0.45, obsolete: 0.15 }, 0.5),
        },
      }),
    }, { trigger: 'threshold' });
    expect(result.report).toMatchObject({ status: 'ran', kept: 1 });
    expect(result.evidence.items[0]?.text).toContain('keep-me');
  });

  it('shortens obsolete command and test results instead of dropping them', async () => {
    const evidence = bundle([
      item('cmd', { kind: 'command', status: 'succeeded', text: bulky('Completed: pnpm test'), sourceId: 'hist-1', toolCallId: 'call-1', toolName: 'bash' }),
      item('test', { kind: 'test', status: 'succeeded', text: bulky('✓ 42 passed'), sourceId: 'hist-2', toolCallId: 'call-2', toolName: 'bash' }),
    ]);
    const result = await pruneEvidence(evidence, span(), {
      evaluate: async () => ({
        answers: {
          e1: choice('obsolete', { exact_contents: 0.02, outcome_only: 0.08, obsolete: 0.9 }, 0.9),
          e2: choice('obsolete', { exact_contents: 0.02, outcome_only: 0.08, obsolete: 0.9 }, 0.9),
        },
      }),
    }, { trigger: 'manual' });
    expect(result.report).toMatchObject({ status: 'ran', dropped: 0, shortened: 2 });
    expect(result.evidence.items).toHaveLength(2);
  });

  it('skips classification when nothing is bulky enough to ask about', async () => {
    const evidence = bundle([
      item('req', { kind: 'request', status: 'requested', text: 'Fix login', sourceId: 'user-1' }),
      item('obs', { kind: 'observation', status: 'observed', text: 'tiny', sourceId: 'hist-1', toolCallId: 'call-1' }),
    ]);
    const evaluate = async () => {
      throw new Error('classifier should not run');
    };
    const result = await pruneEvidence(evidence, span(), { evaluate }, { trigger: 'manual' });
    expect(result.report).toEqual({ status: 'skipped', reason: 'no-candidates' });
    expect(result.evidence.items).toEqual(evidence.items);
  });

  it('keeps original evidence when the classifier returns invalid answers', async () => {
    const evidence = bundle([
      item('obs', { kind: 'observation', status: 'observed', text: bulky('keep-me'), sourceId: 'hist-1', toolCallId: 'call-1' }),
    ]);
    const result = await pruneEvidence(evidence, span(), {
      evaluate: async () => ({ answers: {} }),
    }, { trigger: 'manual' });
    expect(result.report).toMatchObject({ status: 'ran', kept: 1, asked: 1 });
    expect(result.evidence.items[0]?.text).toContain('keep-me');
    expect(result.report.status === 'ran' && result.report.decisions[0]).toMatchObject({
      id: 'e1', action: 'keep', reason: 'missing',
    });
  });

  it('classifies every bulky group across provider request batches', async () => {
    const evidence = bundle(
      Array.from({ length: 80 }, (_, index) => item(`obs-${index}`, {
        kind: 'observation',
        status: 'observed',
        text: bulky(`result-${index}`),
        sourceId: `hist-${index}`,
        toolCallId: `call-${index}`,
        toolName: 'grep',
      })),
    );
    const evaluate = vi.fn(async (_state: unknown, questions: Record<string, unknown>) => ({
      answers: Object.fromEntries(
        Object.keys(questions).map((id) => [id, choice('exact_contents', { exact_contents: 0.9, outcome_only: 0.05, obsolete: 0.05 }, 0.8)]),
      ),
    }));
    const result = await pruneEvidence(evidence, span(), { evaluate }, { trigger: 'overflow' });
    expect(result.report.status).toBe('ran');
    if (result.report.status !== 'ran') return;
    expect(result.report.asked).toBeGreaterThan(0);
    expect(result.report.asked).toBe(80);
    expect(result.report.kept + result.report.shortened + result.report.dropped).toBe(80);
    expect(result.report.shortened).toBe(0);
    expect(Object.keys(evaluate.mock.calls[0]?.[1] ?? {})).toHaveLength(result.report.asked);
    expect(result.debug.bulky).toBe(80);
    expect(result.debug.leftover).toBe(0);
    expect(result.debug.questions).toBeDefined();
    expect(result.debug.state).toEqual(expect.objectContaining({
      history: expect.any(Array),
      trigger: expect.stringContaining('End-of-turn'),
    }));
  });

  it('describes mid-turn overflow using the unfinished current_turn', async () => {
    const evidence = bundle([
      item('obs', { kind: 'observation', status: 'observed', text: bulky('old-search'), sourceId: 'hist-1', toolCallId: 'call-1', toolName: 'grep' }),
      item('prefix', { kind: 'observation', status: 'observed', text: bulky('current-output'), sourceId: 'prefix-1', toolCallId: 'call-2', toolName: 'grep' }),
    ]);
    const evaluate = vi.fn(async (_state: unknown, _questions: Record<string, unknown>) => ({
      answers: { e1: choice('obsolete', { exact_contents: 0.05, outcome_only: 0.1, obsolete: 0.85 }, 0.8) },
    }));
    await pruneEvidence(evidence, span(['prefix-1']), { evaluate }, { trigger: 'overflow' });
    expect(evaluate.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      trigger: expect.stringContaining('unfinished task in current_turn'),
    }));
  });
});

function choice(
  value: 'exact_contents' | 'outcome_only' | 'obsolete',
  probabilities: Record<'exact_contents' | 'outcome_only' | 'obsolete', number>,
  confidence: number,
): CompactionClassifierChoiceAnswer {
  return { type: 'choice', choice: value, probabilities, confidence };
}

function item(id: string, value: Partial<EvidenceItem> & Pick<EvidenceItem, 'kind' | 'status' | 'text' | 'sourceId'>): EvidenceItem {
  return {
    id,
    provenance: 'observed',
    ...value,
  };
}

function bundle(items: EvidenceItem[]): EvidenceBundle {
  return { schemaVersion: 1, items, omitted: { itemCount: 0, byteCount: 0, reasons: [] } };
}

function span(prefixIds: string[] = []): PreparedSpan {
  return {
    schemaVersion: 1,
    firstKeptEntryId: 'keep-1',
    sources: prefixIds.map((sourceId, index) => ({
      sourceId,
      section: 'turn_prefix',
      index,
    })),
    omitted: { itemCount: 0, byteCount: 0, reasons: [] },
  };
}
