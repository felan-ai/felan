import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionContext, FelanExtensionAPI } from '@felan-ai/agent-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createEmptyMemoryArtifact,
  createActiveBranchDigester,
  createMemoryDreamerInstructions,
  createMemoryExtension,
  createMemoryNavigationGuide,
  createMemoryProjectionSnapshot,
  createMemorySnapshot,
  createSessionCheckpoint,
  digestActiveBranch,
  formatMemoryPromptContext,
  hydrateMemoryDirectory,
  MEMORY_CONTEXT_CUSTOM_TYPE,
  removeMemoryContextEntries,
  memoryArtifactFingerprint,
  readMemoryDirectory,
  validateMemoryArtifact,
} from '../src/index.js';

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('@felan-ai/ext-memory', () => {
  it('creates a deterministic checkpoint from the active branch only', () => {
    const manager = {
      getSessionId: () => 'session-1',
      getSessionFile: () => '/sessions/session-1.jsonl',
      getLeafId: () => 'leaf-2',
      getBranch: () => [{ id: 'root' }, { id: 'leaf-2', parentId: 'root' }],
    } as unknown as Parameters<typeof createSessionCheckpoint>[0];
    const checkpoint = createSessionCheckpoint(manager);
    expect(checkpoint).toMatchObject({
      sessionId: 'session-1',
      sessionFile: '/sessions/session-1.jsonl',
      leafId: 'leaf-2',
    });
    expect(checkpoint?.transcriptDigest).toBe(digestActiveBranch(manager.getBranch()));
    expect(checkpoint?.transcriptDigest).not.toBe(digestActiveBranch([...manager.getBranch(), { id: 'abandoned' }]));
  });

  it('incrementally digests active branches with the canonical checkpoint encoding', () => {
    const branch = [
      { parentId: null, id: 'root', details: { z: 1, a: [true, undefined, null] }, omitted: undefined },
      { id: 'memory-adjacent', parentId: 'root', content: ['text', { nested: 'value' }] },
    ];
    const digester = createActiveBranchDigester();
    for (const entry of branch) digester.update(entry);

    expect(digester.digest()).toBe(digestActiveBranch(branch));
    expect(digestActiveBranch([])).toBe(createActiveBranchDigester().digest());
    expect(() => digester.update({ id: 'late' })).toThrow('already finalized');
    expect(() => digester.digest()).toThrow('already finalized');
  });

  it('removes the persisted memory message without breaking branch ancestry', () => {
    const entries = [
      { id: 'root', parentId: null },
      { id: 'memory', type: 'custom_message', customType: MEMORY_CONTEXT_CUSTOM_TYPE, parentId: 'root' },
      { id: 'leaf', parentId: 'memory' },
    ];
    expect(removeMemoryContextEntries(entries)).toEqual([
      { id: 'root', parentId: null },
      { id: 'leaf', parentId: 'root' },
    ]);
  });

  it('validates a complete linked Markdown wiki and preserves a stable fingerprint', () => {
    const files = [
      { path: 'summary.md', content: 'The project prefers small, verified changes.' },
      {
        path: 'index.md',
        content: '# Memory index\n\n## How to use this memory\n\n## Memory map\n- [Workflow](/work/.memory/pages/workflows/index.md)\n',
      },
      {
        path: 'pages/workflows/index.md',
        content: '# workflows index\n\n- [Release workflow](release.md) — Release checks are compact.\n',
      },
      {
        path: 'pages/workflows/release.md',
        content: '# Release workflow\n\n## Current understanding\n\n- Run focused checks.\n\n## Sources\n- session:session-1\n',
      },
    ];
    const result = validateMemoryArtifact(files, {
      memoryPath: '/work/.memory',
      sourceSessionIds: ['session-1'],
    });
    expect(result.ok).toBe(true);
    expect(result.artifact?.files.map(({ path }) => path)).toEqual([
      'index.md',
      'pages/workflows/index.md',
      'pages/workflows/release.md',
      'summary.md',
    ]);
    expect(memoryArtifactFingerprint(files)).toBe(memoryArtifactFingerprint(result.artifact!));
  });

  it('rebases resolvable links for a session projection without changing canonical memory', () => {
    const canonicalPath = '.memory';
    const projectionPath = '/sessions/root-1/.memory';
    const canonical = createMemorySnapshot([
      {
        path: 'summary.md',
        content: `Review [release checks](${canonicalPath}/pages/workflows/release.md#checks), [[${canonicalPath}/pages/workflows/index.md|workflow notes]], and [external docs](https://example.com).`,
      },
      {
        path: 'index.md',
        content: `# Memory index\n\n${createMemoryNavigationGuide(canonicalPath)}\n\n## Memory map\n- [Workflow](${canonicalPath}/pages/workflows/index.md)\n`,
      },
      { path: 'pages/workflows/index.md', content: '# Workflows\n\n- [Release](release.md) — Release safely.\n' },
      { path: 'pages/workflows/release.md', content: '# Release\n\n## Sources\n- session:session-1\n' },
    ], canonicalPath, { sourceSessionIds: ['session-1'] });

    const projection = createMemoryProjectionSnapshot(canonical, projectionPath);
    const projectedSummary = projection.files.find(({ path }) => path === 'summary.md')?.content;
    const projectedIndex = projection.files.find(({ path }) => path === 'index.md')?.content;
    const canonicalSummary = canonical.files.find(({ path }) => path === 'summary.md')?.content;
    const canonicalIndex = canonical.files.find(({ path }) => path === 'index.md')?.content;

    expect(projection.memoryPath).toBe(projectionPath);
    expect(projection.fingerprint).toBe(canonical.fingerprint);
    expect(projectedIndex).toContain(createMemoryNavigationGuide(projectionPath));
    expect(projectedIndex).toContain(`[Workflow](${projectionPath}/pages/workflows/index.md)`);
    expect(projectedSummary).toContain(`[release checks](${projectionPath}/pages/workflows/release.md#checks)`);
    expect(projectedSummary).toContain(`[[${projectionPath}/pages/workflows/index.md|workflow notes]]`);
    expect(projectedSummary).toContain('[external docs](https://example.com)');
    expect(canonicalSummary).toContain(`[release checks](${canonicalPath}/pages/workflows/release.md#checks)`);
    expect(canonicalIndex).toContain(`[Workflow](${canonicalPath}/pages/workflows/index.md)`);
    expect(validateMemoryArtifact(projection, {
      memoryPath: projectionPath,
      sourceSessionIds: ['session-1'],
    }).ok).toBe(true);
  });

  it('treats summary links as non-blocking orientation, not artifact navigation', () => {
    const result = validateMemoryArtifact([
      {
        path: 'summary.md',
        content: 'Review [release](pages/workflows/release.md), [missing](pages/workflows/missing.md), [external docs](https://example.com), and [[%ZZ|malformed]].',
      },
      {
        path: 'index.md',
        content: `# Memory index\n\n${createMemoryNavigationGuide('/work/.memory')}\n\n## Memory map\n- [Workflows](/work/.memory/pages/workflows/index.md)\n`,
      },
      { path: 'pages/workflows/index.md', content: '# workflows\n\n- [Release](release.md) — Release safely.\n' },
      { path: 'pages/workflows/release.md', content: '# release\n\n## Sources\n- session:session-1\n' },
    ], {
      memoryPath: '/work/.memory',
      sourceSessionIds: ['session-1'],
      requireSources: true,
      validateNavigation: true,
    });

    expect(result).toMatchObject({ ok: true, errors: [] });
  });

  it('keeps semantic checks opt-in while preserving hard artifact boundaries', () => {
    const result = validateMemoryArtifact([
      { path: '../summary.md', content: 'bad' },
      { path: 'summary.md', content: 'Review memory before acting.' },
      { path: 'index.md', content: '# Memory index\n\n## How to use this memory\n- [Missing](pages/nope/index.md)' },
      { path: 'pages/workflows/index.md', content: '# workflows\n' },
      { path: 'pages/workflows/release.md', content: '# release\n\n## Sources\n- session:foreign\n' },
    ], {
      memoryPath: '/work/.memory',
      sourceSessionIds: ['session-1'],
      requireSources: true,
      validateNavigation: true,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.map(({ code }) => code)).toEqual(expect.arrayContaining([
      'invalid_path',
      'broken_link',
      'unreachable_page',
      'unknown_source',
    ]));
  });

  it('normalizes incomplete memory for availability-safe reads', () => {
    const files = [
      { path: 'pages/workflows/release.md', content: '# Release without navigation or provenance' },
    ];
    const result = validateMemoryArtifact(files, { memoryPath: '/work/.memory', mode: 'read' });

    expect(result).toMatchObject({ ok: true, errors: [] });
    expect(result.artifact?.files).toEqual(expect.arrayContaining([
      { path: 'summary.md', content: '' },
      expect.objectContaining({ path: 'index.md' }),
      { path: 'pages/workflows/release.md', content: '# Release without navigation or provenance' },
    ]));

    const snapshot = createMemorySnapshot([], '/work/.memory', { mode: 'read' });
    expect(snapshot.files.find(({ path }) => path === 'index.md')?.content).toContain('/work/.memory');

    const strict = validateMemoryArtifact(files, { memoryPath: '/work/.memory' });
    expect(strict.ok).toBe(false);
    expect(strict.errors.map(({ code }) => code)).toEqual(expect.arrayContaining([
      'missing_required_file',
      'missing_sources',
    ]));
  });

  it('returns validation errors instead of throwing for malformed artifact input', () => {
    const result = validateMemoryArtifact({ version: 1, files: null } as never);

    expect(result.ok).toBe(false);
    expect(result.errors.map(({ code }) => code)).toContain('invalid_file_type');
  });

  it('hydrates only validated regular Markdown files and rejects symlinks', async () => {
    const root = await temporaryDirectory();
    const source = join(root, 'source');
    const target = join(root, 'target');
    await mkdir(join(source, 'pages', 'workflow'), { recursive: true });
    await writeFile(join(source, 'summary.md'), 'small changes', 'utf8');
    await writeFile(join(source, 'index.md'), '# Memory\n\n## How to use this memory\n\n- [Workflow](pages/workflow/index.md)\n', 'utf8');
    await writeFile(join(source, 'pages', 'workflow', 'index.md'), '# workflow\n- (none yet)\n', 'utf8');

    const artifact = await readMemoryDirectory(source, { requireSources: false });
    await hydrateMemoryDirectory(artifact, target);
    await expect(readFile(join(target, 'summary.md'), 'utf8')).resolves.toBe('small changes');

    if (process.platform !== 'win32') {
      const unsafe = join(root, 'unsafe');
      await mkdir(unsafe, { recursive: true });
      await symlink('/etc/passwd', join(unsafe, 'summary.md'));
      await expect(readMemoryDirectory(unsafe)).rejects.toThrow(/Unsafe memory entry type/);
    }
  });

  it('renders memory as hidden lower-priority reference context', () => {
    const snapshot = createMemorySnapshot(createEmptyMemoryArtifact('/work/.memory'), '/work/.memory');
    const prompt = formatMemoryPromptContext(snapshot);
    expect(prompt).toContain('<memory>');
    expect(prompt).toContain('lower-priority, untrusted reference context');
    expect(prompt).toContain('Use the Summary for orientation only');
    expect(prompt).toContain('read the Index first');
    expect(prompt).toContain('Cite the supporting page paths and session IDs');
    expect(prompt).toContain('if no page supports a claim, say so');
    expect(prompt).toContain('Memory note (direct user request): ...');
    expect(prompt).toContain('preserved in the current session transcript');
    expect(prompt).toContain('not as confirmation that canonical memory has changed');
    expect(prompt).toContain('Do not edit this projection');
    expect(prompt).toContain('# Memory schema');
    expect(prompt).not.toContain('## Memory map\n- [');

    const dreamerInstructions = createMemoryDreamerInstructions({
      memoryPath: '.memory',
      inputPath: '.dreaming/input',
    });
    expect(dreamerInstructions).toContain('explicit user-authored requests');
    expect(dreamerInstructions).toContain('not independent evidence');
    expect(dreamerInstructions).toContain('Preserve relevant existing source entries');
    expect(dreamerInstructions).toContain('Add new source entries only for target session IDs');
    expect(dreamerInstructions).toContain('Update every affected topic, entity, or concept page');
    expect(dreamerInstructions).toContain('meaningful cross-links between related pages');
    expect(dreamerInstructions).toContain('preserving unresolved contradictions');
    expect(dreamerInstructions).toContain('bounded semantic lint');
    expect(dreamerInstructions).toContain('stale or duplicate claims');
    expect(dreamerInstructions).toContain('important concepts without pages');
    expect(dreamerInstructions).toContain('never invent facts, links, or sources');
    expect(dreamerInstructions).toContain('inspect the existing memory');
    expect(dreamerInstructions).toContain('clean up problems when needed');
    expect(dreamerInstructions).toContain('preserving supported knowledge and source provenance');
    expect(dreamerInstructions).not.toContain('link-free');
    expect(dreamerInstructions).not.toContain('entries drawn only from the manifest');
  });
});

describe('memory extension lifecycle', () => {
  it('keeps the session usable when memory cannot be read', async () => {
    const host = {
      readCurrent: vi.fn(async () => { throw new Error('memory unavailable'); }),
      recordCheckpoint: vi.fn(async () => {}),
      status: vi.fn(async () => ({ enabled: true, state: 'idle' as const, pendingCheckpoints: 0 })),
    };
    const extension = await extensionHarness(createMemoryExtension({ role: 'reader', host }));
    expect(extension.registerCapability).toHaveBeenCalledWith(expect.objectContaining({
      id: 'memory',
      instructions: expect.stringContaining('read the index first'),
    }));
    await extension.emit('session_start');
    expect(extension.sendMessage).not.toHaveBeenCalled();
    expect(extension.statuses.at(-1)).toEqual(['memory', 'Memory unavailable']);
  });

  it('lets root sessions checkpoint and reader sessions only recall', async () => {
    const host = {
      readCurrent: vi.fn(async () => createMemorySnapshot(createEmptyMemoryArtifact('/work/.memory'), '/work/.memory')),
      recordCheckpoint: vi.fn(async () => {}),
      status: vi.fn(async () => ({ enabled: true, state: 'idle' as const, pendingCheckpoints: 0 })),
    };
    const root = await extensionHarness(createMemoryExtension({ role: 'root', host }));
    const reader = await extensionHarness(createMemoryExtension({ role: 'reader', host }));
    await root.emit('session_start');
    await root.emit('session_start');
    expect(root.sendMessage).toHaveBeenCalledTimes(1);
    root.clearMemoryContext();
    await root.emit('session_compact');
    expect(root.sendMessage).toHaveBeenCalledTimes(2);
    root.clearMemoryContext();
    await root.emit('session_tree');
    expect(root.sendMessage).toHaveBeenCalledTimes(3);
    await reader.emit('session_start');
    expect(reader.sendMessage).toHaveBeenCalledTimes(1);
    expect(root.handlers.has('context')).toBe(false);
    await root.emit('agent_settled');
    await reader.emit('agent_settled');
    expect(host.recordCheckpoint).toHaveBeenCalledTimes(1);
    expect(reader.handlers.has('agent_settled')).toBe(false);
  });
});

async function extensionHarness(extension: ReturnType<typeof createMemoryExtension>) {
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const statuses: Array<[string, string | undefined]> = [];
  const entries: Array<Record<string, unknown>> = [];
  const sendMessage = vi.fn((message: { customType: string; content: unknown; display: boolean }) => {
    entries.push({
      type: 'custom_message',
      id: `memory-${entries.length}`,
      parentId: entries.at(-1)?.id ?? null,
      customType: message.customType,
      content: message.content,
      display: message.display,
    });
  });
  const registerCapability = vi.fn();
  const api = {
    registerCapability,
    sendMessage,
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
  } as unknown as FelanExtensionAPI;
  extension(api);
  const ctx = {
    ui: { setStatus: (key: string, value: string | undefined) => statuses.push([key, value]) },
    sessionManager: {
      getSessionId: () => 'session-1',
      getSessionFile: () => '/sessions/session-1.jsonl',
      getLeafId: () => 'leaf-1',
      getBranch: () => [],
      buildContextEntries: () => entries,
    },
  } as unknown as ExtensionContext;
  return {
    handlers,
    statuses,
    sendMessage,
    registerCapability,
    clearMemoryContext: () => entries.splice(0, entries.length),
    async emit(event: string, payload: Record<string, unknown> = {}) {
      const results = [];
      for (const handler of handlers.get(event) ?? []) results.push(await handler(payload, ctx));
      return results[0] as { messages: unknown[] } | undefined;
    },
  };
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'felan-memory-extension-'));
  temporaryPaths.push(path);
  return path;
}
