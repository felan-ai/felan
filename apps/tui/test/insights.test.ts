import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionManager } from '@felan-ai/agent-core';
import { createInsightsExtension, type Analytics } from '@felan-ai/ext-insights';
import { createLocalInsightsHost } from '../src/insights.js';
import type { MemoryRunMetadata } from '../src/memory/run.js';

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

  it.each(['completed', 'failed', 'cancelled', 'interrupted'] as const)(
    'counts a %s memory run once as a standalone session on fresh and cached scans',
    async (status) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-09-01T12:00:00Z'));
      const root = await mkdtemp(join(tmpdir(), 'felan-insights-memory-'));
      paths.push(root);
      const projectRoot = join(root, 'workspace');
      const sessionDir = join(root, 'sessions');
      const memoryDir = join(sessionDir, 'memory');
      await mkdir(projectRoot);
      const sources = [SessionManager.create(projectRoot, sessionDir), SessionManager.create(projectRoot, sessionDir)];
      sources.forEach((source, index) => appendUsage(source, index + 1));
      const memory = SessionManager.create(projectRoot, memoryDir);
      const memoryFile = memory.getSessionFile()!;
      const metadata: MemoryRunMetadata = {
        version: 1, kind: 'memory', sessionId: memory.getSessionId(), sessionFile: basename(memoryFile),
        projectKey: '1'.repeat(64), projectRoot, startedAt: new Date().toISOString(),
        status: 'started', phase: 'model', baseFingerprint: '2'.repeat(64),
        checkpoints: sources.map((source) => ({
          sessionId: source.getSessionId(), sessionFile: source.getSessionFile()!,
          leafId: source.getLeafId()!, transcriptDigest: '3'.repeat(64),
        })),
      };
      memory.appendSessionInfo('Memory: workspace');
      memory.appendCustomEntry('felan-memory-run', metadata);
      appendUsage(memory, 3);
      appendUsage(memory, 4);
      const usage = { input: 70, output: 35, cacheRead: 21, cacheWrite: 14, totalTokens: 140, costUsd: 0.875 };
      memory.appendCustomEntry('felan-memory-run', { ...metadata, phase: 'validate', usage });
      memory.appendCustomEntry('felan-memory-run', { ...metadata, status, finishedAt: new Date().toISOString(), usage });
      await writeFile(join(memoryDir, 'manifest.json'), JSON.stringify({ ...metadata, status, usage }));
      await mkdir(join(memoryDir, 'input'));
      await writeFile(join(memoryDir, 'input', 'copy.jsonl'), await readFile(memoryFile));
      await mkdir(join(sessionDir, 'unrelated'));
      await writeFile(join(sessionDir, 'unrelated', 'ignored.jsonl'), await readFile(memoryFile));

      const cache = new Map<string, Uint8Array>();
      const runtime = {
        storage: () => ({
          root: join(root, 'storage', 'agent'),
          readFile: async (path: string) => {
            const bytes = cache.get(path);
            if (!bytes) throw new Error('Cache miss');
            return bytes;
          },
          writeFile: async (path: string, bytes: Uint8Array) => { cache.set(path, bytes); },
          mkdir: vi.fn(),
        }),
      };
      const host = createLocalInsightsHost();
      const references = await host.listSessions(runtime as never);
      const files = [...sources.map((source) => source.getSessionFile()!), memoryFile];
      expect(references.map((reference) => reference.path).sort()).toEqual([...files].sort());
      expect(new Set(references.map((reference) => reference.id)).size).toBe(3);
      for (const reference of references) {
        expect(reference).not.toHaveProperty('rootSessionId');
        expect(reference).not.toHaveProperty('isAgent');
      }

      let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
      const reports: Analytics[] = [];
      const writeReport = vi.fn(async () => join(root, 'report.html'));
      createInsightsExtension({
        ...host,
        enrichAnalytics: async (analytics) => { reports.push(analytics); return analytics; },
        writeReport,
      })({ runtime, registerCommand: (_name: string, definition: typeof command) => { command = definition; } } as never);
      vi.setSystemTime(new Date('2026-09-01T12:01:00Z'));
      await command!.handler('--no-open', { ui: { notify: vi.fn() } });
      await command!.handler('--no-open', { ui: { notify: vi.fn() } });

      expect(writeReport).toHaveBeenCalledTimes(2);
      expect(reports).toHaveLength(2);
      for (const report of reports) {
        expect(report).toMatchObject({ totalSessions: 3, totalMessages: 4, totalTokens: 200, totalCost: 1.25 });
        expect(report.sessions.map((session) => session.id).sort()).toEqual(files.map((file) => basename(file, '.jsonl')).sort());
        for (const [index, multiplier] of [1, 2, 7].entries()) {
          expect(report.sessions.find((session) => session.id === basename(files[index]!, '.jsonl'))).toMatchObject({
            cwd: projectRoot, projectName: 'workspace', agentSessionCount: 1,
            assistantMessageCount: index === 2 ? 2 : 1,
            tokenUsage: { input: 10 * multiplier, output: 5 * multiplier, cacheRead: 3 * multiplier, cacheWrite: 2 * multiplier, total: 20 * multiplier },
            cost: { total: 0.125 * multiplier },
          });
        }
      }
      expect(reports[0]!.cache?.sessionMeta).toMatchObject({ hits: 0, misses: 3, writes: 3 });
      expect(reports[1]!.cache?.sessionMeta).toMatchObject({ hits: 3, misses: 0, writes: 0 });
    },
  );

  it('counts configured-sessionDir memory usage once on fresh and cached scans', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-01T12:00:00Z'));
    const root = await mkdtemp(join(tmpdir(), 'felan-insights-custom-sessions-'));
    paths.push(root);
    const projectRoot = join(root, 'workspace');
    const sessionDir = join(root, 'custom', 'sessions');
    await Promise.all([mkdir(projectRoot), mkdir(join(sessionDir, 'memory'), { recursive: true })]);
    const ordinary = SessionManager.create(projectRoot, sessionDir);
    const memory = SessionManager.create(projectRoot, join(sessionDir, 'memory'));
    appendUsage(ordinary, 1);
    appendUsage(memory, 2);
    const cache = new Map<string, Uint8Array>();
    const runtime = {
      storage: () => ({
        root: join(root, 'storage', 'agent'),
        readFile: async (path: string) => {
          const value = cache.get(path);
          if (!value) throw new Error('Cache miss');
          return value;
        },
        writeFile: async (path: string, value: Uint8Array) => { cache.set(path, value); },
        mkdir: vi.fn(),
      }),
    };
    const host = createLocalInsightsHost(undefined, sessionDir);
    const references = await host.listSessions(runtime as never);
    expect(references.map(({ path }) => path).sort()).toEqual([
      memory.getSessionFile()!, ordinary.getSessionFile()!,
    ].sort());
    expect(new Set(references.map(({ id }) => id))).toHaveLength(2);
    let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
    const reports: Analytics[] = [];
    createInsightsExtension({
      ...host,
      enrichAnalytics: async (analytics) => { reports.push(analytics); return analytics; },
      writeReport: async () => join(root, 'report.html'),
    })({ runtime, registerCommand: (_name: string, definition: typeof command) => { command = definition; } } as never);

    vi.setSystemTime(new Date('2026-09-01T12:01:00Z'));
    const notify = vi.fn();
    await command!.handler('--no-open', { ui: { notify } });
    await command!.handler('--no-open', { ui: { notify } });

    expect(reports).toHaveLength(2);
    expect(reports[0]).toMatchObject({ totalSessions: 2, totalMessages: 2, totalTokens: 60 });
    expect(reports[0]!.cache?.sessionMeta).toMatchObject({ hits: 0, misses: 2, writes: 2 });
    expect(reports[1]!.cache?.sessionMeta).toMatchObject({ hits: 2, misses: 0, writes: 0 });
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

function appendUsage(session: SessionManager, multiplier: number): void {
  session.appendMessage({
    role: 'assistant', content: [{ type: 'text', text: 'Fixture response' }],
    provider: 'openai', model: 'fixture-model', api: 'openai-responses', stopReason: 'stop', timestamp: Date.now(),
    usage: {
      input: 10 * multiplier, output: 5 * multiplier, cacheRead: 3 * multiplier, cacheWrite: 2 * multiplier,
      totalTokens: 20 * multiplier,
      cost: { input: 0.0625 * multiplier, output: 0.03125 * multiplier, cacheRead: 0.015625 * multiplier, cacheWrite: 0.015625 * multiplier, total: 0.125 * multiplier },
    },
  });
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
