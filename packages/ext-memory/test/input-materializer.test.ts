import { describe, expect, it } from 'vitest';
import {
  digestActiveBranch,
  materializeMemoryInputDelta,
  MEMORY_CONTEXT_CUSTOM_TYPE,
  MEMORY_INPUT_JSONL_FORMAT,
  type SessionCheckpoint,
} from '../src/index.js';

const header = { type: 'session', version: 3, id: 'session-1', timestamp: '2026-01-01T00:00:00Z', cwd: '/work' };

describe('memory input checkpoint deltas', () => {
  it('projects visible evidence, reparents hidden context, redacts secrets, and omits image data', async () => {
    const root = message('root', null, 'user', [
      { type: 'text', text: 'Keep this preference. Bearer abcdefghijklmnop' },
      { type: 'image', data: 'private-base64-image', mimeType: 'image/png' },
    ]);
    const hidden = {
      type: 'custom_message', id: 'memory', parentId: 'root', timestamp: timestamp(),
      customType: MEMORY_CONTEXT_CUSTOM_TYPE, content: 'old memory', display: false,
    };
    const assistant = message('assistant', 'memory', 'assistant', [
      { type: 'text', text: 'Calling a tool' },
      { type: 'toolCall', id: 'call-1', name: 'read', arguments: { apiKey: 'do-not-leak', 'sk-abcdefghijklmnop': 'key value' } },
    ]);
    const tool = message('tool', 'assistant', 'toolResult', [{ type: 'text', text: 'ghp_abcdefghijklmnopqrstuvwxyz' }]);
    const model = { type: 'model_change', id: 'model', parentId: 'tool', timestamp: timestamp(), provider: 'test', modelId: 'small' };
    const compaction = {
      type: 'compaction', id: 'compact', parentId: 'model', timestamp: timestamp(), summary: 'Durable summary',
      firstKeptEntryId: 'root', tokensBefore: 42, details: { kind: 'fixture' },
    };
    const summary = {
      type: 'branch_summary', id: 'leaf', parentId: 'compact', timestamp: timestamp(), fromId: 'root',
      summary: 'Branch summary', details: { reason: 'navigation' },
    };
    const visible = [root, { ...assistant, parentId: 'root' }, tool, model, compaction, summary];
    const checkpoint = checkpointFor('leaf', visible);

    const result = await materializeMemoryInputDelta({
      lines: lineSource([header, root, hidden, assistant, tool, model, compaction, summary]),
      checkpoint,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result).toMatchObject({
      format: MEMORY_INPUT_JSONL_FORMAT,
      byteLength: new TextEncoder().encode(result.text).byteLength,
      projection: {
        relation: 'initial', includedEntryCount: 6, evidenceRecordCount: 5, removedEntryCount: 2,
      },
    });
    expect(result.redactionCount).toBe(5);
    expect(result.text).not.toMatch(/abcdefghijklmnop|private-base64-image|do-not-leak|ghp_abcdefghijklmnopqrstuvwxyz|old memory/);
    const records = parseJsonl(result.text);
    expect(records.map(({ id }) => id)).toEqual(['root', 'assistant', 'tool', 'compact', 'leaf']);
    expect(records[1]).toMatchObject({ id: 'assistant', parentId: 'root' });
    expect(records[3]).toMatchObject({ summary: 'Durable summary', details: { kind: 'fixture' } });
    expect(records[4]).toMatchObject({ summary: 'Branch summary', details: { reason: 'navigation' } });
    expect(records[0]).toMatchObject({ message: { content: [expect.anything(), { data: '[IMAGE_DATA_OMITTED]' }] } });
    expect(result.materializedDigest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('classifies unchanged and appended lineages using their longest common prefix', async () => {
    const root = message('root', null, 'user', 'one');
    const prior = message('prior', 'root', 'assistant', [{ type: 'text', text: 'two' }]);
    const leaf = message('leaf', 'prior', 'user', 'three');
    const previousCheckpoint = checkpointFor('prior', [root, prior]);
    const checkpoint = checkpointFor('leaf', [root, prior, leaf]);
    const lines = lineSource([header, root, prior, leaf]);

    const appended = await materializeMemoryInputDelta({ lines, checkpoint, previousCheckpoint });
    expect(appended).toMatchObject({
      ok: true,
      projection: { relation: 'appended', includedEntryCount: 1, evidenceRecordCount: 1, previousCheckpoint },
    });
    if (appended.ok) expect(parseJsonl(appended.text).map(({ id }) => id)).toEqual(['leaf']);

    const unchanged = await materializeMemoryInputDelta({
      lines,
      checkpoint: previousCheckpoint,
      previousCheckpoint,
      maxOutputBytes: 0,
    });
    expect(unchanged).toMatchObject({
      ok: true,
      text: '',
      byteLength: 0,
      projection: { relation: 'unchanged', includedEntryCount: 0, evidenceRecordCount: 0 },
    });
  });

  it('emits the complete current visible lineage after divergence', async () => {
    const root = message('root', null, 'user', 'root evidence');
    const oldLeaf = message('old', 'root', 'assistant', [{ type: 'text', text: 'old branch' }]);
    const newLeaf = message('new', 'root', 'assistant', [{ type: 'text', text: 'new branch' }]);
    const result = await materializeMemoryInputDelta({
      lines: lineSource([header, root, oldLeaf, newLeaf]),
      checkpoint: checkpointFor('new', [root, newLeaf]),
      previousCheckpoint: checkpointFor('old', [root, oldLeaf]),
    });

    expect(result).toMatchObject({ ok: true, projection: { relation: 'diverged', includedEntryCount: 2 } });
    if (result.ok) expect(parseJsonl(result.text).map(({ id }) => id)).toEqual(['root', 'new']);
  });

  it('is deterministic across source object key order', async () => {
    const first = message('root', null, 'user', 'same');
    const reordered = { message: first.message, timestamp: first.timestamp, parentId: null, id: 'root', type: 'message' };
    const checkpoint = checkpointFor('root', [first]);
    const left = await materializeMemoryInputDelta({ lines: lineSource([header, first]), checkpoint });
    const right = await materializeMemoryInputDelta({ lines: lineSource([header, reordered]), checkpoint });
    expect(left).toEqual(right);
  });

  it('rejects output over the cap without returning partial JSONL', async () => {
    const root = message('root', null, 'user', 'bounded evidence');
    const options = { lines: lineSource([header, root]), checkpoint: checkpointFor('root', [root]) };
    const complete = await materializeMemoryInputDelta(options);
    expect(complete.ok).toBe(true);
    if (!complete.ok) return;
    const limited = await materializeMemoryInputDelta({ ...options, maxOutputBytes: complete.byteLength - 1 });
    expect(limited).toEqual({
      ok: false,
      code: 'output_too_large',
      message: 'Memory checkpoint evidence exceeds the output byte limit',
    });
    expect('text' in limited).toBe(false);
    expect(parseJsonl(complete.text)).toHaveLength(1);
  });

  it.each([
    ['wrong header', [{ ...header, id: 'other-session' }]],
    ['duplicate IDs', [header, message('same', null, 'user', 'a'), message('same', null, 'user', 'b')]],
    ['missing parent', [header, message('leaf', 'parent-secret-value', 'user', 'a')]],
    ['cycle', [header, message('one', 'two', 'user', 'a'), message('two', 'one', 'user', 'b')]],
    ['malformed JSONL', [JSON.stringify(header), '{"secret":"credential-value"']],
  ])('rejects %s without leaking source content', async (_case, records) => {
    const lines = typeof records[0] === 'string'
      ? () => strings(records as string[])
      : lineSource(records as Record<string, unknown>[]);
    const result = await materializeMemoryInputDelta({
      lines,
      checkpoint: {
        sessionId: 'session-1', sessionFile: '/sessions/session-1.jsonl', leafId: null, transcriptDigest: digestActiveBranch([]),
      },
    });
    expect(result).toMatchObject({ ok: false, code: 'invalid_source' });
    if (!result.ok) expect(result.message).not.toMatch(/credential-value|parent-secret-value|one|two|same|other-session/);
  });

  it('detects a non-replayable or changed source', async () => {
    const root = message('root', null, 'user', 'original');
    let read = 0;
    const result = await materializeMemoryInputDelta({
      lines: () => strings((read += 1) === 1
        ? [JSON.stringify(header), JSON.stringify(root)]
        : [JSON.stringify(header), JSON.stringify({ ...root, message: { role: 'user', content: 'changed-secret' } })]),
      checkpoint: checkpointFor('root', [root]),
    });
    expect(result).toEqual({
      ok: false,
      code: 'source_changed',
      message: 'Memory checkpoint source changed while it was being read',
    });
    expect(JSON.stringify(result)).not.toContain('changed-secret');
  });

  it('validates current and previous digests independently', async () => {
    const root = message('root', null, 'user', 'evidence');
    const valid = checkpointFor('root', [root]);
    const changed = { ...valid, transcriptDigest: 'a'.repeat(64) };
    await expect(materializeMemoryInputDelta({ lines: lineSource([header, root]), checkpoint: changed }))
      .resolves.toMatchObject({ ok: false, code: 'checkpoint_changed' });
    await expect(materializeMemoryInputDelta({ lines: lineSource([header, root]), checkpoint: valid, previousCheckpoint: changed }))
      .resolves.toMatchObject({ ok: false, code: 'previous_checkpoint_changed' });
  });

  it('returns a deterministic cancellation result', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await materializeMemoryInputDelta({
      lines: lineSource([header]),
      checkpoint: checkpointFor(null, []),
      signal: controller.signal,
    });
    expect(result).toEqual({
      ok: false,
      code: 'cancelled',
      message: 'Memory input materialization was cancelled',
    });
  });
});

function message(id: string, parentId: string | null, role: string, content: unknown) {
  return {
    type: 'message', id, parentId, timestamp: timestamp(),
    message: { role, content, ...(role === 'toolResult' ? { toolName: 'read' } : {}) },
  };
}

function checkpointFor(leafId: string | null, branch: readonly unknown[]): SessionCheckpoint {
  return {
    sessionId: 'session-1',
    sessionFile: '/sessions/session-1.jsonl',
    leafId,
    transcriptDigest: digestActiveBranch(branch),
  };
}

function lineSource(records: readonly Record<string, unknown>[]) {
  const lines = records.map((record) => JSON.stringify(record));
  return () => strings(lines);
}

async function* strings(lines: readonly string[]): AsyncIterable<string> {
  for (const line of lines) yield line;
}

function parseJsonl(text: string): Record<string, unknown>[] {
  return text.trim().length === 0 ? [] : text.trimEnd().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
}

function timestamp(): string {
  return '2026-01-01T00:00:00Z';
}
