import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Api, Model, ModelRuntime } from '@felan-ai/agent-core';
import {
  createMemoryNavigationGuide,
  digestActiveBranch,
  hydrateMemoryDirectory,
  readMemoryDirectory,
  type MemoryInputManifest,
} from '@felan-ai/ext-memory';
import { LocalMemoryCoordinator } from '../src/memory/coordinator.js';
import { createDefaultLocalMemoryDreamRunner, type LocalMemoryDreamSession } from '../src/memory/dreamer.js';
import { localMemoryProjectDirectory, resolveLocalMemoryProject } from '../src/memory/project.js';

interface Fixture {
  readonly sessions: Array<{ readonly id: string; readonly entries: Array<{
    readonly id: string;
    readonly message: { readonly role: string; readonly content: string };
  }> }>;
  readonly existing: Array<{ readonly path: string; readonly content: string }>;
  readonly expected: { readonly summary: string; readonly detail: string; readonly omitted: string; readonly sources: string[] };
}

const toolNames = ['read', 'ls', 'grep', 'edit', 'write', 'remove_memory_page'];

describe('memory decision comparison fixture', () => {
  const publishedByMode = new Map<string, string>();
  it.each(['full', 'jsonl', 'view'] as const)('publishes the same sourced wiki with %s evidence', async (mode) => {
    const guided = mode !== 'full';
    const fixture = JSON.parse(await readFile(new URL('./fixtures/memory-classification.json', import.meta.url), 'utf8')) as Fixture;
    fixture.existing.push(...Array.from({ length: 30 }, (_, index) => ({
      path: `pages/archive/status_${index}.md`,
      content: `# Old status ${index}\n\n${'Routine task status. '.repeat(25)}\n\n## Sources\n- session:previous\n`,
    })));
    const root = await mkdtemp(join(tmpdir(), 'felan-memory-compare-'));
    const cwd = join(root, 'project');
    const agentDir = join(root, 'agent');
    await mkdir(cwd);
    let coordinator: LocalMemoryCoordinator | undefined;
    try {
      const project = await resolveLocalMemoryProject(cwd);
      await hydrateMemoryDirectory(fixture.existing, join(localMemoryProjectDirectory(agentDir, project), 'current'), {
        memoryPath: '.memory', mode: 'read',
      });
      const modelRuntime = { getAvailableSnapshot: () => [{
        provider: 'test', id: 'test-mini', input: ['text'], reasoning: true,
      } as Model<Api>] } as unknown as ModelRuntime;
      let prompt = '';
      let thinking = '';
      let classifierCalls = 0;
      coordinator = new LocalMemoryCoordinator({
        agentDir, modelRuntime, recover: false,
        ...(guided ? { classifier: { canEvaluate: (state: unknown) => Buffer.byteLength(JSON.stringify(state)) < 32_000,
          classify: async (state: unknown, questions: Record<string, unknown>) => {
          classifierCalls += 1;
          const data = state as { items: Array<{ content: string }> };
          const items = data.items;
          return { answers: Object.fromEntries(Object.keys(questions).map((id, index) => [id, {
            type: 'choice', confidence: 0.95,
            choice: items[index]!.content.includes('permanent release smoke') || items[index]!.content.includes('auth incident')
              ? 'inspect' : 'noise',
          }])), metadata: { usage: { requests: 1, inputTokens: 50, outputTokens: 4, costUsd: 0.001 }, elapsedMs: 12 } };
        } } } : {}),
        dreamRunner: createDefaultLocalMemoryDreamRunner({ createSession: async (options) => {
          thinking = options.thinkingLevel ?? '';
          const session: LocalMemoryDreamSession = {
            abort: async () => {}, bindExtensions: async () => {}, dispose: () => {},
            getActiveToolNames: () => toolNames, setActiveToolsByName: () => {},
            messages: [{ role: 'assistant', stopReason: 'stop', content: [] }] as never,
            prompt: async (text) => {
              prompt = text;
              await simulateWikiWorker(options.runtime.cwd, fixture, text, mode);
            },
          };
          return { session };
        } }),
      });

      const host = coordinator.createSessionHost({ cwd, sessionStorageRoot: join(root, 'projection') });
      for (const { id, entries } of fixture.sessions) {
        const persisted = entries.map((entry, index) => ({
          ...entry, type: 'message', parentId: index === 0 ? null : entries[index - 1]!.id,
          timestamp: new Date(index * 1_000).toISOString(),
        }));
        const sessionFile = join(cwd, `${id}.jsonl`);
        await writeFile(sessionFile, [
          JSON.stringify({ type: 'session', id, version: 3, cwd }),
          ...persisted.map((entry) => JSON.stringify(entry)), '',
        ].join('\n'));
        await host.recordCheckpoint({
          sessionId: id, sessionFile, leafId: entries.at(-1)!.id,
          transcriptDigest: digestActiveBranch(persisted),
        });
      }
      expect(await coordinator.runNow(cwd)).toMatchObject({ state: 'idle', pendingCheckpoints: 0 });
      const published = await readMemoryDirectory(await coordinator.canonicalDirectory(cwd), {
        memoryPath: '.memory', sourceSessionIds: fixture.expected.sources,
      });
      publishedByMode.set(mode, JSON.stringify(published.files));
      if (mode !== 'full') expect(publishedByMode.get(mode)).toBe(publishedByMode.get('full'));
      const files = new Map(published.files.map(({ path, content }) => [path, content]));
      expect(files.get('summary.md')).toBe(fixture.expected.summary);
      expect(files.get('pages/decisions/release.md')).toContain(`- session:${fixture.expected.sources[0]}`);
      expect(files.get('pages/decisions/incident.md')).toContain(`- session:${fixture.expected.sources[1]}`);
      expect(files.get('pages/decisions/incident.md')).toContain(fixture.expected.detail);
      expect(JSON.stringify(published)).not.toContain(fixture.expected.omitted);
      expect(published.files.some(({ path }) => path.startsWith('pages/archive/'))).toBe(false);
      expect(prompt.includes('decisions.json')).toBe(guided);
      expect(thinking).toBe('medium');
      expect(classifierCalls > 0).toBe(guided);
      const runs = join(localMemoryProjectDirectory(agentDir, project), 'runs');
      const runIds = await readdir(runs);
      expect(runIds).toHaveLength(1);
      const run = JSON.parse(await readFile(join(runs, runIds[0]!, 'manifest.json'), 'utf8')) as {
        triage?: { counts: { inspect: number; noise: number; uncertain: number }; inputTokens: number; costUsd: number };
      };
      if (guided) {
        expect(run.triage).toMatchObject({ counts: { inspect: 2, noise: 1, uncertain: 0 },
          inputTokens: 50 * classifierCalls, costUsd: 0.001 * classifierCalls });
        expect(JSON.stringify(run.triage)).not.toContain(fixture.expected.detail);
      } else {
        expect(run.triage).toBeUndefined();
      }
    } finally {
      await coordinator?.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function simulateWikiWorker(stagingDirectory: string, fixture: Fixture, prompt: string, mode: 'full' | 'jsonl' | 'view'): Promise<void> {
  const inputDirectory = join(stagingDirectory, '.dreaming', 'input');
  const manifest = JSON.parse(await readFile(join(inputDirectory, 'manifest.json'), 'utf8')) as MemoryInputManifest;
  const guided = prompt.includes('decisions.json');
  const selected: Array<{ sessionId: string; role: string; content: string; decision: string }> = [];
  let removeOld = false;
  if (guided) {
    const map = JSON.parse(await readFile(join(inputDirectory, 'decisions.json'), 'utf8')) as {
      baseMemoryFingerprint: string;
      sessions: Array<{ sessionId: string; inspectPath: string; noisePath: string; inspectViewPath?: string }>;
    };
    if (map.baseMemoryFingerprint !== manifest.baseMemoryFingerprint) throw new Error('Decision map does not match the base wiki');
    const sessionIds = new Set(manifest.sessions.map(({ checkpoint }) => checkpoint.sessionId));
    for (const { sessionId, inspectPath, noisePath, inspectViewPath } of map.sessions) {
      if (!sessionIds.has(sessionId) || !inspectPath.endsWith('/inspect.jsonl') || !noisePath.endsWith('/noise.jsonl')) {
        throw new Error('Split evidence map does not match the manifest');
      }
      if (mode === 'view') {
        if (!inspectViewPath) throw new Error('Missing readable inspect view');
        const view = await readFile(join(inputDirectory, inspectViewPath), 'utf8');
        for (const block of view.trim().split(/\n\[\/source\](?:\n\n|\n|$)/u).filter(Boolean)) {
          const [header, ...lines] = block.split('\n');
          const match = /^\[source session=("[^"]+") entry=("[^"]+") role=(user|assistant|toolResult)\]$/u.exec(header!);
          if (!match || JSON.parse(match[1]!) !== sessionId
            || !fixture.sessions.find(({ id }) => id === sessionId)?.entries.some(({ id }) => id === JSON.parse(match[2]!))
            || lines.some((line) => !line.startsWith('| '))) throw new Error('Invalid readable inspect source');
          const content = lines.map((line) => line.slice(2)).join('\n');
          selected.push({ sessionId, role: match[3]!, content,
            decision: content.includes('permanent release smoke') ? 'summary' : 'inspect' });
        }
      } else {
        const entries = (await readFile(join(inputDirectory, inspectPath), 'utf8')).trim().split('\n');
        for (const line of entries.filter(Boolean)) {
          const entry = JSON.parse(line) as { message?: { role: string; content: string } };
          if (entry.message) selected.push({ sessionId, role: entry.message.role, content: entry.message.content,
            decision: entry.message.content.includes('permanent release smoke') ? 'summary' : 'inspect' });
        }
      }
    }
    if (!removeOld) {
      removeOld = (await readFile(join(stagingDirectory, '.memory/pages/workflows/pause.md'), 'utf8'))
        .includes(fixture.expected.omitted);
    }
  } else {
    for (const { transcriptPath, checkpoint } of manifest.sessions) {
      for (const line of (await readFile(join(inputDirectory, transcriptPath), 'utf8')).trim().split('\n')) {
        const entry = JSON.parse(line) as { message?: { role: string; content: string } };
        if (entry.message) selected.push({
          sessionId: checkpoint.sessionId, role: entry.message.role, content: entry.message.content,
          decision: entry.message.content.includes('permanent release smoke') ? 'summary' : 'detail',
        });
      }
    }
    removeOld = (await readFile(join(stagingDirectory, '.memory/pages/workflows/pause.md'), 'utf8'))
      .includes(fixture.expected.omitted);
  }
  const release = selected.find(({ role, content, decision }) => role === 'user'
    && decision === 'summary' && content.includes('successful login') && content.includes('blocked-account login'));
  const incident = selected.find(({ role, content, decision }) => role === 'user'
    && decision !== 'noise' && content.includes('auth incident') && content.includes('discarded'));
  const files = [
    { path: 'summary.md', content: release ? fixture.expected.summary : '' },
    { path: 'index.md', content: `# Memory index\n\n${createMemoryNavigationGuide('.memory')}\n\n## Memory map\n- [Decisions](.memory/pages/decisions/index.md)\n` },
    { path: 'pages/decisions/index.md', content: '# Decisions\n\n- [Release checks](release.md)\n- [Auth incident](incident.md)\n' },
    ...(release ? [{ path: 'pages/decisions/release.md', content: `# Release checks\n\n${fixture.expected.summary}\n\n## Sources\n- session:${release.sessionId}\n` }] : []),
    ...(incident ? [{ path: 'pages/decisions/incident.md', content: `# Auth incident\n\n${fixture.expected.detail}\n\n## Sources\n- session:${incident.sessionId}\n` }] : []),
    ...(!removeOld ? fixture.existing.filter(({ path }) => path === 'pages/workflows/pause.md') : []),
  ];
  await hydrateMemoryDirectory(files, join(stagingDirectory, '.memory'), {
    replace: true, memoryPath: '.memory', sourceSessionIds: [...fixture.expected.sources, 'previous'],
  });
}
