import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
  it('uses the selected authenticated model instead of the first available model', async () => {
    const stagingDirectory = await temporaryDirectory();
    const firstAvailable = { provider: 'google', id: 'fast-first-model' } as Model<Api>;
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
        getAvailableSnapshot: () => [firstAvailable],
        hasConfiguredAuth: (provider: string) => provider === selectedModel.provider,
      } as unknown as ModelRuntime,
      selectedModel,
    }));

    expect(captured?.model).toBe(selectedModel);
  });

  it('falls back to an available model when the selected model is no longer authenticated', async () => {
    const stagingDirectory = await temporaryDirectory();
    const firstAvailable = { provider: 'google', id: 'fast-first-model' } as Model<Api>;
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
        hasConfiguredAuth: () => false,
      } as unknown as ModelRuntime,
      selectedModel,
    }));

    expect(captured?.model).toBe(firstAvailable);
  });

  it('runs a filesystem-backed Pi session with no extensions or process access', async () => {
    const stagingDirectory = await temporaryDirectory();
    await mkdir(join(stagingDirectory, '.memory'), { recursive: true });
    await mkdir(join(stagingDirectory, '.dreaming', 'input'), { recursive: true });
    await writeFile(join(stagingDirectory, '.memory', 'summary.md'), 'existing memory', 'utf8');
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
    expect(session.bound).toBe(true);
    expect(session.activeTools).toEqual(['read', 'ls', 'edit', 'write']);
    expect(session.promptText).toContain('Read .dreaming/input/manifest.json');
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

function fakeSession(options: { readonly waitForPrompt?: boolean } = {}): FakeSession {
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
    messages: [{
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
    readonly signal?: AbortSignal;
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
      getAvailableSnapshot: () => [{}],
    } as unknown as ModelRuntime,
    ...(options.selectedModel === undefined ? {} : { selectedModel: options.selectedModel }),
    signal: options.signal ?? new AbortController().signal,
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
