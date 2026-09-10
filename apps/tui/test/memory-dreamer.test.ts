import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Api, Model, ModelRuntime } from '@felan-ai/agent-core';
import {
  createEmptyMemoryArtifact,
  createMemorySnapshot,
  digestActiveBranch,
  removeMemoryContextEntries,
  type MemoryInputManifest,
} from '@felan-ai/ext-memory';
import {
  createDefaultLocalMemoryDreamRunner,
  materializeMemoryInput,
  type LocalMemoryDreamSession,
  type LocalMemoryDreamSessionFactory,
} from '../src/memory/dreamer.js';

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('createDefaultLocalMemoryDreamRunner', () => {
  it('persists a standard memory session before creating the model session', async () => {
    const stagingDirectory = await temporaryDirectory();
    const session = fakeSession();
    const runner = createDefaultLocalMemoryDreamRunner({
      createSession: async ({ sessionManager }) => {
        const sessionFile = sessionManager.getSessionFile();
        expect(sessionFile).toBeTypeOf('string');
        const entries = (await readFile(sessionFile!, 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as unknown);
        expect(entries).toEqual(expect.arrayContaining([
          expect.objectContaining({ type: 'session', id: sessionManager.getSessionId() }),
          expect.objectContaining({
            type: 'custom',
            data: expect.objectContaining({ kind: 'memory' }),
          }),
        ]));
        expect(session.promptStarted).toBe(false);
        return { session: session.session };
      },
    });

    await expect(runner(inputFor(stagingDirectory, {
      sessionDirectory: join(stagingDirectory, 'sessions'),
    }))).resolves.toBeUndefined();
    const files = await readdir(join(stagingDirectory, 'sessions'));
    const persisted = (await readFile(join(stagingDirectory, 'sessions', files[0]!), 'utf8'))
      .trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(persisted).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'custom', customType: 'felan-memory-run', data: expect.objectContaining({ status: 'completed' }) }),
    ]));
  });

  it('persists a safe failed outcome when no low-tier model is available', async () => {
    const stagingDirectory = await temporaryDirectory();
    const sessionDirectory = join(stagingDirectory, 'sessions');
    const runner = createDefaultLocalMemoryDreamRunner();
    const highTierModel = {
      provider: 'openai-codex', id: 'gpt-5.6-sol', input: ['text'],
    } as Model<Api>;
    const excludedLowTierModel = {
      provider: 'openai-codex', id: 'gpt-5.6-luna', input: ['text'],
    } as Model<Api>;

    await expect(runner(inputFor(stagingDirectory, {
      sessionDirectory,
      modelRuntime: {
        getAvailableSnapshot: () => [excludedLowTierModel, highTierModel],
      } as unknown as ModelRuntime,
      scopedModels: [highTierModel],
    }))).rejects.toThrow('No authenticated low-tier local memory model is configured');

    const files = await readdir(sessionDirectory);
    const entries = (await readFile(join(sessionDirectory, files[0]!), 'utf8'))
      .trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'custom', customType: 'felan-memory-run',
        data: expect.objectContaining({ status: 'failed', error: 'No authenticated low-tier local memory model is configured' }),
      }),
    ]));
  });

  it('treats an empty configured model scope as having no eligible models', async () => {
    const stagingDirectory = await temporaryDirectory();
    const lowTierModel = {
      provider: 'openai-codex', id: 'gpt-5.6-luna', input: ['text'],
    } as Model<Api>;
    const runner = createDefaultLocalMemoryDreamRunner();

    await expect(runner(inputFor(stagingDirectory, {
      modelRuntime: { getAvailableSnapshot: () => [lowTierModel] } as unknown as ModelRuntime,
      scopedModels: [],
    }))).rejects.toThrow('No authenticated low-tier local memory model is configured');
  });

  it('redacts provider error fields before persisting the standard JSONL transcript', async () => {
    const stagingDirectory = await temporaryDirectory();
    const sessionDirectory = join(stagingDirectory, 'sessions');
    const secret = 'private-provider-token';
    const assistant = {
      role: 'assistant',
      content: [],
      provider: 'openai',
      model: 'fixture-model',
      api: 'openai-responses',
      stopReason: 'error',
      errorMessage: `Provider failed apiKey=${secret} Bearer ${secret}`,
      timestamp: Date.now(),
      usage: {
        input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    const session = fakeSession({ assistant });
    const runner = createDefaultLocalMemoryDreamRunner({
      createSession: async ({ sessionManager }) => {
        sessionManager.appendMessage(assistant as never);
        return { session: session.session };
      },
    });

    await expect(runner(inputFor(stagingDirectory, { sessionDirectory }))).rejects.toThrow('Provider failed');

    const [sessionFile] = await readdir(sessionDirectory);
    const transcript = await readFile(join(sessionDirectory, sessionFile!), 'utf8');
    const [runId] = await readdir(join(stagingDirectory, '.memory-runs', 'runs'));
    const manifest = await readFile(join(stagingDirectory, '.memory-runs', 'runs', runId!, 'manifest.json'), 'utf8');
    expect(transcript).toContain('[REDACTED_TOKEN]');
    expect(manifest).toContain('[REDACTED_TOKEN]');
    expect(transcript).not.toContain(secret);
    expect(manifest).not.toContain(secret);
  });

  it('prefers a low-tier model from the selected model provider and family', async () => {
    const stagingDirectory = await temporaryDirectory();
    const firstAvailable = {
      provider: 'google', id: 'gemini-4-flash-lite', input: ['text'],
    } as Model<Api>;
    const preferredLowTier = {
      provider: 'openai-codex', id: 'gpt-5.6-luna', input: ['text'],
    } as Model<Api>;
    const selectedModel = { provider: 'openai-codex', id: 'gpt-5.6-sol' } as Model<Api>;
    const session = fakeSession();
    let captured: Parameters<LocalMemoryDreamSessionFactory>[0] | undefined;
    const createSession: LocalMemoryDreamSessionFactory = async (options) => {
      captured = options;
      return { session: session.session };
    };
    const runner = createDefaultLocalMemoryDreamRunner({ createSession });

    await runner(inputFor(stagingDirectory, {
      modelRuntime: {
        getAvailableSnapshot: () => [firstAvailable, preferredLowTier],
      } as unknown as ModelRuntime,
      selectedModel,
    }));

    expect(captured?.model).toBe(preferredLowTier);
    expect(captured?.thinkingLevel).toBe('medium');
  });

  it('uses an available low-tier model when the selected provider has none', async () => {
    const stagingDirectory = await temporaryDirectory();
    const firstAvailable = {
      provider: 'google', id: 'gemini-4-flash-lite', input: ['text'],
    } as Model<Api>;
    const selectedModel = { provider: 'openai-codex', id: 'expired-model' } as Model<Api>;
    const session = fakeSession();
    let captured: Parameters<LocalMemoryDreamSessionFactory>[0] | undefined;
    const createSession: LocalMemoryDreamSessionFactory = async (options) => {
      captured = options;
      return { session: session.session };
    };
    const runner = createDefaultLocalMemoryDreamRunner({ createSession });

    await runner(inputFor(stagingDirectory, {
      modelRuntime: {
        getAvailableSnapshot: () => [firstAvailable],
      } as unknown as ModelRuntime,
      selectedModel,
    }));

    expect(captured?.model).toBe(firstAvailable);
  });

  it('runs a filesystem-backed Pi session with no extensions or process access', async () => {
    const stagingDirectory = await temporaryDirectory();
    await mkdir(join(stagingDirectory, '.memory'), { recursive: true });
    await mkdir(join(stagingDirectory, '.memory', 'pages', 'evaluations'), { recursive: true });
    await mkdir(join(stagingDirectory, '.dreaming', 'input'), { recursive: true });
    await writeFile(join(stagingDirectory, '.memory', 'summary.md'), 'existing memory', 'utf8');
    await writeFile(join(stagingDirectory, '.memory', 'index.md'), '# Memory index', 'utf8');
    await writeFile(join(stagingDirectory, '.memory', 'pages', 'evaluations', 'index.md'), '# Evaluations', 'utf8');
    await writeFile(join(stagingDirectory, '.memory', 'pages', 'evaluations', 'stale.md'), 'stale memory', 'utf8');
    await writeFile(join(stagingDirectory, '.dreaming', 'input', 'manifest.json'), '{}', 'utf8');
    const session = fakeSession();
    let captured: Parameters<LocalMemoryDreamSessionFactory>[0] | undefined;
    const createSession: LocalMemoryDreamSessionFactory = async (options) => {
      captured = options;
      return { session: session.session };
    };
    const runner = createDefaultLocalMemoryDreamRunner({ createSession });

    await expect(runner(inputFor(stagingDirectory))).resolves.toBeUndefined();
    expect(captured?.extensionPackages).toEqual([]);
    expect(captured?.appendSystemPrompt?.[0]).toContain('.dreaming/input');
    expect(captured?.appendSystemPrompt?.[0]).toContain('.memory');
    expect(captured?.customTools?.map(({ name }) => name)).toEqual(['remove_memory_page']);
    expect(session.bound).toBe(true);
    expect(session.activeTools).toEqual(['read', 'ls', 'edit', 'write', 'remove_memory_page']);
    expect(session.promptText).toContain('Read .dreaming/input/manifest.json');
    expect(session.promptText).toContain('Keep memory sparse');
    expect(session.promptText).toContain('direct user-authored durable facts');
    expect(session.promptText).toContain('not be cheaply recovered');
    expect(session.promptText).toContain('Delete old repository mirrors');
    expect(session.promptText).toContain('Use remove_memory_page');
    expect(session.promptText).not.toContain('Return only a JSON object');
    expect(session.disposed).toBe(true);

    const runtime = captured!.runtime;
    await expect(runtime.readFile(join(stagingDirectory, '.dreaming', 'input', 'manifest.json')))
      .resolves.toEqual(new TextEncoder().encode('{}'));
    await runtime.writeFile(
      join(stagingDirectory, '.memory', 'summary.md'),
      new TextEncoder().encode('updated memory'),
    );
    await expect(readFile(join(stagingDirectory, '.memory', 'summary.md'), 'utf8'))
      .resolves.toBe('updated memory');
    const largeContent = 'large memory\n'.repeat(60_000);
    await runtime.writeFile(
      join(stagingDirectory, '.memory', 'large.md'),
      new TextEncoder().encode(largeContent),
    );
    await expect(runtime.readFile(join(stagingDirectory, '.memory', 'large.md')))
      .resolves.toHaveLength(Buffer.byteLength(largeContent, 'utf8'));
    await expect(runtime.readFile(join(stagingDirectory, 'outside.txt'))).rejects.toThrow(
      'outside the staged memory inputs',
    );
    await expect(runtime.writeFile(
      join(stagingDirectory, '.dreaming', 'input', 'manifest.json'),
      new TextEncoder().encode('tampered'),
    )).rejects.toThrow('outside the staged memory inputs');
    const removeMemoryPage = captured!.customTools![0]!;
    await expect(removeMemoryPage.execute(
      'remove-stale',
      { path: '.memory/pages/evaluations/stale.md' },
      undefined,
      undefined,
      {} as never,
    )).resolves.toMatchObject({
      content: [{ type: 'text', text: 'Removed .memory/pages/evaluations/stale.md' }],
      details: { path: '.memory/pages/evaluations/stale.md' },
    });
    await expect(readFile(join(stagingDirectory, '.memory', 'pages', 'evaluations', 'stale.md'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    for (const path of [
      '.memory/summary.md',
      '.memory/index.md',
      '.memory/pages/evaluations/index.md',
      '.memory/pages/evaluations/InDeX.Md',
      '.memory/pages/evaluations',
      '.memory/pages/evaluations/../../index.md',
      '.dreaming/input/manifest.json',
      'outside.md',
    ]) {
      await expect(removeMemoryPage.execute(
        'reject-protected-path',
        { path },
        undefined,
        undefined,
        {} as never,
      )).rejects.toThrow(
        'remove_memory_page only removes individual Markdown content pages under .memory/pages',
      );
    }
    await expect(runtime.exec('cat', ['.memory/summary.md'])).rejects.toThrow(
      'does not permit process execution',
    );
    await expect(runtime.shell('cat .memory/summary.md')).rejects.toThrow(
      'does not permit shell execution',
    );
    expect(runtime.processes).toBeUndefined();
    expect(runtime.terminals).toBeUndefined();
  });

  it('aborts and disposes the Pi session without producing an artifact', async () => {
    const stagingDirectory = await temporaryDirectory();
    const session = fakeSession({ waitForPrompt: true });
    const runner = createDefaultLocalMemoryDreamRunner({
      createSession: async () => ({ session: session.session }),
      timeoutMs: 10_000,
    });
    const controller = new AbortController();
    const running = runner(inputFor(stagingDirectory, { signal: controller.signal }));
    for (let attempt = 0; attempt < 100 && !session.promptStarted; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    controller.abort();

    await expect(running).rejects.toThrow('Memory processing was cancelled');
    expect(session.aborted).toBe(true);
    expect(session.disposed).toBe(true);
  });

  it('uses only a high wall-clock failsafe for a runaway session', async () => {
    const stagingDirectory = await temporaryDirectory();
    const session = fakeSession({ waitForPrompt: true });
    const runner = createDefaultLocalMemoryDreamRunner({
      createSession: async () => ({ session: session.session }),
      timeoutMs: 1,
    });

    await expect(runner(inputFor(stagingDirectory))).rejects.toThrow(
      'Memory dream exceeded its runtime limit',
    );
    expect(session.aborted).toBe(true);
    expect(session.disposed).toBe(true);
  });
});

describe('materializeMemoryInput', () => {
  it('streams a large source file and ignores large abandoned branches', async () => {
    const stagingDirectory = await temporaryDirectory();
    const sessionFile = join(stagingDirectory, 'session.jsonl');
    const entries = [
      sessionEntry('root', null, 'Keep this root evidence.'),
      sessionEntry('active', 'root', 'Keep this active evidence.'),
      sessionEntry('abandoned', 'root', 'Do not ingest this abandoned branch. '.repeat(180_000)),
    ];
    await writeSessionFile(sessionFile, entries);
    const checkpoint = checkpointForEntries(sessionFile, entries.slice(0, 2), 'active');

    const result = await materializeMemoryInput({
      stagingDirectory,
      checkpoints: [checkpoint],
      baseSnapshot: createMemorySnapshot(createEmptyMemoryArtifact('.memory'), '.memory'),
      maxTranscriptBytes: 512,
    });

    expect(result.failures).toEqual([]);
    expect(result.sessions).toHaveLength(1);
    const transcript = await readFile(
      join(stagingDirectory, '.dreaming', 'input', result.sessions[0]!.transcriptPath),
      'utf8',
    );
    expect(Buffer.byteLength(transcript, 'utf8')).toBeLessThanOrEqual(512);
    expect(transcript).toContain('Keep this active evidence.');
    expect(transcript).not.toContain('Do not ingest this abandoned branch.');
  });

  it('accepts a large active branch while bounding the staged evidence', async () => {
    const stagingDirectory = await temporaryDirectory();
    const sessionFile = join(stagingDirectory, 'large-active-session.jsonl');
    const entries = [
      sessionEntry('root', null, 'Keep this root evidence.'),
      sessionEntry('active', 'root', 'Large active evidence. '.repeat(220_000)),
    ];
    await writeSessionFile(sessionFile, entries);
    const checkpoint = checkpointForEntries(sessionFile, entries, 'active');

    const result = await materializeMemoryInput({
      stagingDirectory,
      checkpoints: [checkpoint],
      baseSnapshot: createMemorySnapshot(createEmptyMemoryArtifact('.memory'), '.memory'),
      maxTranscriptBytes: 512,
    });

    expect(result.failures).toEqual([]);
    expect(result.sessions[0]?.byteLength).toBeLessThanOrEqual(512);
    expect(result.sessions[0]?.byteLength).toBeGreaterThan(0);
    const transcript = await readFile(
      join(stagingDirectory, '.dreaming', 'input', result.sessions[0]!.transcriptPath),
      'utf8',
    );
    expect(transcript).toContain('[TRUNCATED]');
  });

  it('isolates a changed checkpoint as a deterministic materialization failure', async () => {
    const stagingDirectory = await temporaryDirectory();
    const sessionFile = join(stagingDirectory, 'changed-session.jsonl');
    const entries = [sessionEntry('root', null, 'Evidence.')];
    await writeSessionFile(sessionFile, entries);

    const result = await materializeMemoryInput({
      stagingDirectory,
      checkpoints: [{
        ...checkpointForEntries(sessionFile, entries, 'root'),
        transcriptDigest: '0'.repeat(64),
      }],
      baseSnapshot: createMemorySnapshot(createEmptyMemoryArtifact('.memory'), '.memory'),
      maxTranscriptBytes: 512,
    });

    expect(result.sessions).toEqual([]);
    expect(result.failures).toMatchObject([{
      code: 'checkpoint_changed',
      checkpoint: { sessionId: 'session-1' },
    }]);
  });

  it('honors cancellation before materializing source evidence', async () => {
    const stagingDirectory = await temporaryDirectory();
    const controller = new AbortController();
    controller.abort();

    await expect(materializeMemoryInput({
      stagingDirectory,
      checkpoints: [],
      baseSnapshot: createMemorySnapshot(createEmptyMemoryArtifact('.memory'), '.memory'),
      maxTranscriptBytes: 512,
      signal: controller.signal,
    })).rejects.toThrow('Memory processing was cancelled');
  });
});

interface FakeSession {
  readonly session: LocalMemoryDreamSession;
  readonly activeTools: string[];
  readonly bound: boolean;
  readonly disposed: boolean;
  readonly aborted: boolean;
  readonly promptStarted: boolean;
  readonly promptText: string | undefined;
}

function fakeSession(options: { readonly waitForPrompt?: boolean; readonly assistant?: Record<string, unknown> } = {}): FakeSession {
  let activeTools = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'];
  let bound = false;
  let disposed = false;
  let aborted = false;
  let promptStarted = false;
  let promptText: string | undefined;
  let resolvePrompt: (() => void) | undefined;
  const session = {
    abort: async () => {
      aborted = true;
      resolvePrompt?.();
    },
    bindExtensions: async () => {
      bound = true;
    },
    dispose: () => {
      disposed = true;
    },
    getActiveToolNames: () => [...activeTools],
    messages: [options.assistant ?? {
      role: 'assistant',
      stopReason: 'stop',
      content: [{ type: 'text', text: 'The staged memory is complete.' }],
    }],
    prompt: async (text: string) => {
      promptStarted = true;
      promptText = text;
      if (options.waitForPrompt) {
        await new Promise<void>((resolve) => {
          resolvePrompt = resolve;
        });
      }
    },
    setActiveToolsByName: (names: string[]) => {
      activeTools = [...names];
    },
  } as unknown as LocalMemoryDreamSession;
  return {
    session,
    get activeTools() {
      return activeTools;
    },
    get bound() {
      return bound;
    },
    get disposed() {
      return disposed;
    },
    get aborted() {
      return aborted;
    },
    get promptStarted() {
      return promptStarted;
    },
    get promptText() {
      return promptText;
    },
  };
}

function inputFor(
  stagingDirectory: string,
  options: {
    readonly modelRuntime?: ModelRuntime;
    readonly selectedModel?: Model<Api>;
    readonly scopedModels?: readonly Model<Api>[];
    readonly signal?: AbortSignal;
    readonly sessionDirectory?: string;
  } = {},
) {
  const artifact = createEmptyMemoryArtifact('.memory');
  const manifest: MemoryInputManifest = {
    version: 1,
    createdAt: new Date(0).toISOString(),
    baseMemoryFingerprint: createMemorySnapshot(artifact, '.memory').fingerprint,
    sessions: [],
  };
  return {
    stagingDirectory,
    memoryDirectory: join(stagingDirectory, '.memory'),
    inputDirectory: join(stagingDirectory, '.dreaming', 'input'),
    baseSnapshot: createMemorySnapshot(artifact, '.memory'),
    manifest,
    modelRuntime: options.modelRuntime ?? {
      getAvailableSnapshot: () => [{
        provider: 'test', id: 'test-mini', input: ['text'],
      } as Model<Api>],
    } as unknown as ModelRuntime,
    ...(options.selectedModel === undefined ? {} : { selectedModel: options.selectedModel }),
    ...(options.scopedModels === undefined ? {} : { scopedModels: options.scopedModels }),
    signal: options.signal ?? new AbortController().signal,
    ...(options.sessionDirectory === undefined ? {} : { sessionDirectory: options.sessionDirectory }),
  };
}

function sessionEntry(id: string, parentId: string | null, text: string): Record<string, unknown> {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: `2026-01-01T00:00:${id === 'root' ? '00' : '01'}.000Z`,
    message: { role: 'user', content: text },
  };
}

async function writeSessionFile(sessionFile: string, entries: readonly Record<string, unknown>[]): Promise<void> {
  await writeFile(sessionFile, [
    JSON.stringify({ type: 'session', version: 3, id: 'session-1', timestamp: new Date().toISOString(), cwd: '/' }),
    'this is a malformed session entry and should be skipped',
    ...entries.map((entry) => JSON.stringify(entry)),
    '',
  ].join('\n'), 'utf8');
}

function checkpointForEntries(
  sessionFile: string,
  entries: readonly Record<string, unknown>[],
  leafId: string,
) {
  return {
    sessionId: 'session-1',
    sessionFile,
    leafId,
    transcriptDigest: digestActiveBranch(removeMemoryContextEntries(entries)),
  } as const;
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'felan-memory-dreamer-'));
  temporaryPaths.push(path);
  return path;
}
