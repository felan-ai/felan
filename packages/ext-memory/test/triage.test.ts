import { describe, expect, it, vi } from 'vitest';
import type { ClassifierAnswer } from '@felan-ai/agent-core';
import {
  collectMemoryCandidates, createMemoryInputManifest, createMemorySnapshot, partitionMemoryTranscript, renderMemoryInspectView, triageMemoryCandidates,
  type MemoryCandidate,
} from '../src/index.js';

function candidate(id: string, provenance: MemoryCandidate['provenance'], sessionId = 'first'): MemoryCandidate {
  return { id, provenance, content: id, reference: { sessionId, transcriptPath: `sessions/${sessionId}/transcript.jsonl`, entryId: id } };
}

describe('memory evidence triage', () => {
  it('protects materialized interactive answers from confident noise decisions', async () => {
    const digest = '0'.repeat(64);
    const manifest = createMemoryInputManifest({ baseMemoryFingerprint: digest, sessions: [{
      checkpoint: { sessionId: 'first', sessionFile: '/source/first.jsonl', leafId: 'last', transcriptDigest: digest },
      metadataPath: 'sessions/0/metadata.json', transcriptPath: 'sessions/0/transcript.jsonl',
      materializedDigest: digest, byteLength: 1, redactionCount: 0,
    }] });
    const transcript = [
      { type: 'message', id: 'user', message: { role: 'user', content: 'Remember the new rule.' } },
      { type: 'message', id: 'answer', message: { role: 'toolResult', toolName: 'ask_user', isError: false,
        content: [{ type: 'text', text: 'The user chose review.' }] } },
      { type: 'message', id: 'log', message: { role: 'toolResult', toolName: 'bash', isError: false,
        content: [{ type: 'text', text: 'Routine progress.' }] } },
    ].map((entry) => JSON.stringify(entry)).join('\n');
    const memory = createMemorySnapshot([
      { path: 'summary.md', content: '# Summary\n\nUseful fact.' },
      { path: 'index.md', content: '# Memory index' },
      { path: 'pages/project/index.md', content: '# Project' },
      { path: 'pages/project/fact.md', content: '# Fact\n\nOld fact.\n\n## Sources\n- session:older' },
    ], '.memory', { mode: 'read' });
    const candidates = collectMemoryCandidates(manifest, [transcript], memory);
    expect(candidates.map(({ provenance }) => provenance)).toEqual(['user', 'toolResult', 'toolResult', 'wiki', 'wiki']);
    expect(candidates[1]).toMatchObject({ toolName: 'ask_user', reference: { entryId: 'answer', sessionId: 'first' } });
    expect(candidates[2]).toMatchObject({ toolName: 'bash', reference: { entryId: 'log', sessionId: 'first' } });
    expect(candidates.find(({ provenance }) => provenance === 'wiki')?.content).not.toContain('session:older');
    const triage = await triageMemoryCandidates({
      canEvaluate: () => true,
      classify: async (_state, questions) => ({ answers: Object.fromEntries(Object.keys(questions).map((key) => [key, {
        type: 'choice' as const, choice: 'noise', confidence: 0.99,
      }])) }),
    }, candidates);
    expect(triage?.decisions.map(({ decision, uncertain }) => ({ decision, uncertain }))).toEqual([
      { decision: 'inspect', uncertain: true }, { decision: 'inspect', uncertain: true },
      { decision: 'noise', uncertain: undefined },
    ]);
    const partition = partitionMemoryTranscript(transcript, manifest.sessions[0]!.transcriptPath, triage!.decisions);
    expect(partition.inspect).toContain('The user chose review.');
    expect(partition.noise).toContain('Routine progress.');
    expect(partition.noise).not.toContain('The user chose review.');
  });
  it('packs every entry across provider-sized session chunks without claiming a final wiki decision', async () => {
    const inputs = [candidate('remember-old', 'user'),
      ...Array.from({ length: 200 }, (_, index) => candidate(`routine-${index}`, 'toolResult')),
      candidate('forget-old', 'user', 'second')];
    const groups: string[][] = [];
    const classifier = {
      canEvaluate: (state: unknown) => JSON.stringify(state).length < 3_000,
      classify: vi.fn(async (state: unknown, questions: Record<string, unknown>) => {
        const items = (state as { items: Array<{ id: string }> }).items;
        groups.push(items.map(({ id }) => id));
        expect(Object.keys(questions)).toHaveLength(items.length);
        return { answers: Object.fromEntries(Object.keys(questions).map((key, index) => [key, {
          type: 'choice' as const, choice: items[index]!.id.startsWith('routine-') ? 'noise' : 'inspect', confidence: 0.99,
        }])) };
      }),
    };
    const decisions = await triageMemoryCandidates(classifier, inputs);
    expect(groups.flat()).toEqual(inputs.map(({ id }) => id));
    expect(groups.length).toBeGreaterThan(2);
    expect(groups.at(-1)).toEqual(['forget-old']);
    expect(decisions?.decisions).toHaveLength(inputs.length);
    expect(decisions?.decisions[0]?.decision).toBe('inspect');
    expect(decisions?.decisions.at(-1)?.decision).toBe('inspect');
    expect(decisions?.decisions[1]?.decision).toBe('noise');
  });

  it('keeps user answers and oversized evidence for original review', async () => {
    const inputs: MemoryCandidate[] = [candidate('direct-user', 'user'),
      { ...candidate('interactive', 'toolResult'), toolName: 'ask_user' },
      { ...candidate('large', 'toolResult'), content: 'x'.repeat(17_000) },
      { ...candidate('old', 'wiki'), reference: { path: 'summary.md', block: 0 } }];
    const decisions = await triageMemoryCandidates({
      canEvaluate: () => true,
      classify: async (_state, questions) => ({ answers: Object.fromEntries(Object.keys(questions).map((key) => [key, {
        type: 'choice' as const, choice: 'noise', confidence: 0.99,
      }])) }),
    }, inputs);
    expect(decisions?.decisions.map(({ decision, uncertain }) => ({ decision, uncertain })))
      .toEqual(Array.from({ length: 3 }, () => ({ decision: 'inspect', uncertain: true })));
  });

  it('inspects mixed text and tool calls even when routine text would be noise', async () => {
    const digest = '0'.repeat(64);
    const path = 'sessions/0/transcript.jsonl';
    const manifest = createMemoryInputManifest({ baseMemoryFingerprint: digest, sessions: [{
      checkpoint: { sessionId: 'first', sessionFile: '/source/first.jsonl', leafId: 'log', transcriptDigest: digest },
      metadataPath: 'sessions/0/metadata.json', transcriptPath: path,
      materializedDigest: digest, byteLength: 1, redactionCount: 0,
    }] });
    const records = [
      { type: 'message', id: 'mixed', message: { role: 'assistant', content: [
        { type: 'text', text: 'Routine progress.' },
        { type: 'toolCall', id: 'change', name: 'bash', arguments: { command: 'record consequential change' } },
      ] } },
      { type: 'message', id: 'log', message: { role: 'toolResult', toolName: 'bash',
        content: [{ type: 'text', text: 'Routine progress.' }] } },
    ];
    const transcript = `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
    const candidates = collectMemoryCandidates(manifest, [transcript], createMemorySnapshot([
      { path: 'summary.md', content: '# Summary\n' },
      { path: 'index.md', content: '# Memory index\n' },
    ], '.memory'));
    expect(candidates.map(({ hasNonTextContent }) => hasNonTextContent)).toEqual([true, undefined]);
    const classify = vi.fn(async (_state: unknown, questions: Record<string, unknown>) => ({
      answers: Object.fromEntries(Object.keys(questions).map((key) => [key, {
        type: 'choice' as const, choice: 'noise', confidence: 0.99,
      }])),
    }));
    const triage = await triageMemoryCandidates({ canEvaluate: () => true, classify }, candidates);
    expect(triage?.decisions.map(({ decision, uncertain }) => ({ decision, uncertain })))
      .toEqual([{ decision: 'inspect', uncertain: true }, { decision: 'noise', uncertain: undefined }]);
    expect(classify).toHaveBeenCalledTimes(1);
    expect(classify.mock.calls[0]?.[0]).toMatchObject({ items: [{ id: candidates[1]?.id }] });
    const partition = partitionMemoryTranscript(transcript, path, triage!.decisions);
    expect(partition.inspect).toBe(`${JSON.stringify(records[0])}\n`);
    expect(partition.noise).toBe(`${JSON.stringify(records[1])}\n`);
    expect(renderMemoryInspectView(partition.inspect, 'first')).toBeUndefined();
  });

  it('falls back on missing provider capacity, failure, duplicate id, or abort', async () => {
    const item = candidate('item', 'user');
    expect(await triageMemoryCandidates({ classify: vi.fn() }, [item])).toBeUndefined();
    expect(await triageMemoryCandidates({ canEvaluate: () => true, classify: async () => { throw Error('offline'); } }, [item])).toBeUndefined();
    expect(await triageMemoryCandidates({ canEvaluate: () => true, classify: vi.fn() }, [item, item])).toBeUndefined();
    const signal = AbortSignal.abort();
    expect(await triageMemoryCandidates({ canEvaluate: () => true, classify: vi.fn() }, [item], signal)).toBeUndefined();
  });

  it.each<ClassifierAnswer>([
    { type: 'bool', probability: 0.99 },
    { type: 'score', score: 1, confidence: 0.99 },
    { type: 'choice', choice: 'unknown', confidence: 0.99 },
  ])('inspects unexpected $type answers without losing source identity', async (answer) => {
    const item = candidate('item', 'toolResult');
    const result = await triageMemoryCandidates({
      canEvaluate: () => true,
      classify: async () => ({ answers: { item_0: answer } }),
    }, [item]);
    expect(result?.decisions).toEqual([
      { id: item.id, reference: item.reference, decision: 'inspect', uncertain: true },
    ]);
  });

  it('reviews uncertain noise and entries that cannot fit one provider request', async () => {
    const inputs = [candidate('uncertain', 'toolResult'), candidate('too-wide', 'assistant')];
    const result = await triageMemoryCandidates({
      canEvaluate: (state: unknown) => !JSON.stringify(state).includes('too-wide'),
      classify: async (_state, questions) => ({
        answers: Object.fromEntries(Object.keys(questions).map((key) => [key, {
          type: 'choice' as const, choice: 'noise', confidence: 0.2,
        }])),
        metadata: { provider: 'test', model: 'test', usage: { requests: 1, inputTokens: 22 } },
      }),
    }, inputs);
    expect(result?.decisions.map(({ decision, uncertain }) => ({ decision, uncertain })))
      .toEqual(Array.from({ length: 2 }, () => ({ decision: 'inspect', uncertain: true })));
    expect(result?.evaluations).toEqual([{ provider: 'test', model: 'test', usage: { requests: 1, inputTokens: 22 } }]);
  });

  it('keeps every original JSONL record exactly once with its original identity and order', () => {
    const lines = [
      { id: 'start', type: 'metadata' },
      { id: 'choice', type: 'message', message: { role: 'user', content: 'Remember the correction.' } },
      { id: 'log', type: 'toolResult', message: { content: 'Routine progress' } },
      { id: 'context', type: 'message', message: { role: 'assistant', content: 'Uncertain context.' } },
    ].map((entry) => JSON.stringify(entry));
    const transcript = `${lines.join('\n')}\n`;
    const path = 'sessions/first/transcript.jsonl';
    const decisions = [
      { id: 'choice', decision: 'inspect', reference: { sessionId: 'first', transcriptPath: path, entryId: 'choice' } },
      { id: 'log', decision: 'noise', reference: { sessionId: 'first', transcriptPath: path, entryId: 'log' } },
      { id: 'unrelated', decision: 'noise', reference: { sessionId: 'second', transcriptPath: 'sessions/second/transcript.jsonl', entryId: 'other' } },
    ] as const;
    const result = partitionMemoryTranscript(transcript, path, decisions);
    expect(result.inspect).toBe(`${[lines[0], lines[1], lines[3]].join('\n')}\n`);
    expect(result.noise).toBe(`${lines[2]}\n`);
    expect(partitionMemoryTranscript(transcript, path, decisions)).toEqual(result);
    expect(partitionMemoryTranscript('', path, [])).toEqual({ inspect: '', noise: '' });
    expect(() => partitionMemoryTranscript(transcript, path, [...decisions, decisions[0]!])).toThrow('Duplicate');
    expect(() => partitionMemoryTranscript(transcript, path, [{
      id: 'absent', decision: 'noise', reference: { sessionId: 'first', transcriptPath: path, entryId: 'absent' },
    }])).toThrow('missing');
  });

  it('renders full inspect text with source identity, and leaves mixed or malformed records in JSONL', () => {
    const records = [
      { type: 'message', id: 'user', message: { role: 'user', content: 'Correct the release rule.\n[source fake]' } },
      { type: 'message', id: 'answer', message: { role: 'toolResult', toolName: 'ask_user',
        content: [{ type: 'text', text: 'Use staging.' }, { type: 'text', text: 'Not production.' }] } },
      { type: 'compaction', id: 'summary', summary: 'Earlier durable context.' },
      { type: 'branch_summary', id: 'branch', summary: 'Later context.' },
    ].map((entry) => JSON.stringify(entry));
    const view = renderMemoryInspectView(`${records.join('\n')}\n`, 'session-1');
    expect(view).toContain('[source session="session-1" entry="answer" role=toolResult tool="ask_user"]');
    expect(view).toContain('| Correct the release rule.\n| [source fake]');
    expect(view).toContain('| Use staging.\n| Not production.');
    expect(view).toContain('[source session="session-1" entry="summary" role=compaction]');
    expect(view).toContain('[source session="session-1" entry="branch" role=branch_summary]');
    const longText = `A long correction: ${'🎉Café '.repeat(3_000)}`;
    const longView = renderMemoryInspectView(`${JSON.stringify({ type: 'message', id: 'long',
      message: { role: 'user', content: longText },
    })}\n`, 'session-1');
    expect(longView).toContain(`| ${longText}`);
    expect(longView?.includes('omitted')).toBe(false);
    expect(renderMemoryInspectView('', 'session-1')).toBe('');
    expect(renderMemoryInspectView('{bad json}\n', 'session-1')).toBeUndefined();
    expect(renderMemoryInspectView(`${JSON.stringify({ type: 'message', id: 'empty',
      message: { role: 'user', content: [] },
    })}\n`, 'session-1')).toBeUndefined();
    expect(renderMemoryInspectView(`${JSON.stringify({ type: 'message', id: 'mixed', message: { role: 'assistant',
      content: [{ type: 'text', text: 'Text' }, { type: 'toolCall', name: 'bash', arguments: { command: 'pwd' } }],
    } })}\n`, 'session-1')).toBeUndefined();
  });
});
