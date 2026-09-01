import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalInsightsHost } from '../src/insights.js';

const paths: string[] = [];

describe('local Insights host', () => {
  it('lists root and retained subagent transcripts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'felan-insights-'));
    paths.push(root);
    const agentStorage = join(root, 'storage', 'agent');
    await mkdir(join(root, 'sessions'), { recursive: true });
    await mkdir(join(root, 'subagents', 'root-1', 'sessions'), { recursive: true });
    await writeFile(join(root, 'sessions', 'root.jsonl'), '{}');
    await writeFile(join(root, 'subagents', 'root-1', 'sessions', 'child.jsonl'), '{}');
    const runtime = { storage: () => ({ root: agentStorage }) };

    const references = await createLocalInsightsHost().listSessions(runtime as never);
    expect(references).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'root' }),
      expect.objectContaining({ id: 'child', rootSessionId: 'root-1', isAgent: true }),
    ]));
  });

  it('reads transcripts beyond the former 8 MiB limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'felan-insights-'));
    paths.push(root);
    const file = join(root, 'large.jsonl');
    const content = `{"type":"session","id":"large","timestamp":"2026-09-01T00:00:00Z"}\n${' '.repeat(8 * 1024 * 1024)}\n`;
    await writeFile(file, content);
    const runtime = { storage: () => ({ root: join(root, 'storage', 'agent') }) };
    const result = await createLocalInsightsHost().readSession(runtime as never, { id: 'large', path: file, size: (await readFile(file)).byteLength, modifiedAtMs: 1 });
    expect(result).toBe(content);
    const lines: string[] = [];
    for await (const line of createLocalInsightsHost().readSessionLines!(runtime as never, { id: 'large', path: file, size: content.length, modifiedAtMs: 1 })) lines.push(line);
    expect(lines).toHaveLength(2);
  });
});

afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
