import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntimeCodingTools, type Api, type Classifier, type Model, type ModelRuntime } from '@felan-ai/agent-core';
import {
  createEmptyMemoryArtifact,
  createMemoryInputManifest,
  createMemorySnapshot,
  digestActiveBranch,
  removeMemoryContextEntries,
  type MemoryInputManifest,
  type SessionCheckpoint,
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

  it('stages classifier decisions and gives the worker addressable original evidence', async () => {
    const stagingDirectory = await temporaryDirectory();
    const input = await classifiedInputFor(stagingDirectory);
    const session = fakeSession();
    let captured: Parameters<LocalMemoryDreamSessionFactory>[0] | undefined;
    const classify = vi.fn(async (state: unknown, questions: Record<string, unknown>) => ({
      answers: Object.fromEntries(Object.keys(questions).map((key, index) => [key, {
        type: 'choice', choice: (state as { items: Array<{ provenance: string }> }).items[index]?.provenance === 'user'
          ? 'inspect' : 'noise', confidence: 0.95,
      }])),
    }));
    const runner = createDefaultLocalMemoryDreamRunner({ createSession: async (options) => {
      captured = options;
      return { session: session.session };
    } });

    await runner({ ...input, classifier: { canEvaluate: () => true, classify } });

    expect(classify).toHaveBeenCalled();
    expect(captured?.thinkingLevel).toBe('medium');
    expect(captured?.appendSystemPrompt?.[0]).toContain('Read manifest.json and decisions.json');
    expect(captured?.appendSystemPrompt?.[0]).not.toContain('every listed transcript');
    expect(session.promptText).toContain('decisions.json');
    const path = join(input.inputDirectory, 'decisions.json');
    const map = JSON.parse(await readFile(path, 'utf8')) as {
      version: number; baseMemoryFingerprint: string;
      sessions: Array<{ sessionId: string; inspectPath: string; noisePath: string; inspectDigest: string;
        noiseDigest: string; inspectViewPath?: string; inspectViewDigest?: string }>;
    };
    expect(map).toMatchObject({
      version: 4, baseMemoryFingerprint: input.manifest.baseMemoryFingerprint,
      sessions: [expect.objectContaining({ sessionId: 'session-1' })],
    });
    const { inspectPath, noisePath, inspectDigest, noiseDigest, inspectViewPath, inspectViewDigest } = map.sessions[0]!;
    const inspect = await readFile(join(input.inputDirectory, inspectPath), 'utf8');
    const noise = await readFile(join(input.inputDirectory, noisePath), 'utf8');
    expect(inspect).toContain('A durable user choice');
    expect(noise).toContain('Routine status');
    expect(createHash('sha256').update(inspect).digest('hex')).toBe(inspectDigest);
    expect(createHash('sha256').update(noise).digest('hex')).toBe(noiseDigest);
    expect(inspectViewPath).toBeDefined();
    const view = await readFile(join(input.inputDirectory, inspectViewPath!), 'utf8');
    expect(view).toContain('[source session="session-1" entry="first" role=user]');
    expect(view).toContain('| A durable user choice');
    expect(createHash('sha256').update(view).digest('hex')).toBe(inspectViewDigest);
    expect((await stat(join(input.inputDirectory, inspectViewPath!))).mode & 0o777).toBe(0o400);
    expect(await readFile(join(input.inputDirectory, input.manifest.sessions[0]!.transcriptPath), 'utf8'))
      .toBe(`${inspect.trim()}\n${noise.trim()}\n`);
    expect((await stat(join(input.inputDirectory, inspectPath))).mode & 0o777).toBe(0o400);
    expect((await stat(join(input.inputDirectory, noisePath))).mode & 0o777).toBe(0o400);
    await expect(captured!.runtime.writeFile(join(input.inputDirectory, inspectPath), new TextEncoder().encode('changed')))
      .rejects.toThrow('outside the staged memory inputs');
    expect(JSON.stringify(map)).not.toContain('A durable user choice');
    expect((await stat(path)).mode & 0o777).toBe(0o400);
    await expect(captured!.runtime.writeFile(path, new TextEncoder().encode('tampered'))).rejects.toThrow(
      'outside the staged memory inputs',
    );
    expect(JSON.parse(await readFile(join(input.inputDirectory, 'manifest.json'), 'utf8'))).toMatchObject({
      sessions: expect.arrayContaining([expect.objectContaining({ checkpoint: expect.objectContaining({ sessionId: 'session-1' }) })]),
    });
  });

  it('stages classifier guidance for more than 256 transcript candidates', async () => {
    const input = await classifiedInputFor(await temporaryDirectory());
    const transcript = Array.from({ length: 300 }, (_, index) => JSON.stringify({
      type: 'message', id: `entry-${index}`,
      message: { role: index % 2 === 0 ? 'user' : 'assistant', content: `Evidence ${index}` },
    })).join('\n') + '\n';
    const transcriptPath = join(input.inputDirectory, input.manifest.sessions[0]!.transcriptPath);
    await writeFile(transcriptPath, transcript);
    const manifest = createMemoryInputManifest({
      baseMemoryFingerprint: input.baseSnapshot.fingerprint,
      sessions: [{ ...input.manifest.sessions[0]!,
        materializedDigest: createHash('sha256').update(transcript).digest('hex'),
        byteLength: Buffer.byteLength(transcript),
      }],
    });
    await writeFile(join(input.inputDirectory, 'manifest.json'), JSON.stringify(manifest));
    const classify = vi.fn(async (state: unknown, questions: Record<string, unknown>) => ({
      answers: Object.fromEntries(Object.keys(questions).map((key, index) => [key, {
        type: 'choice' as const,
        choice: (state as { items: Array<{ provenance: string }> }).items[index]!.provenance === 'user' ? 'inspect' : 'noise',
        confidence: 0.95,
      }])),
    }));
    const session = fakeSession();
    let captured: Parameters<LocalMemoryDreamSessionFactory>[0] | undefined;
    await createDefaultLocalMemoryDreamRunner({ createSession: async (options) => {
      captured = options;
      return { session: session.session };
    } })({ ...input, manifest, classifier: { canEvaluate: (state) => JSON.stringify(state).length < 12_000, classify } });

    const map = JSON.parse(await readFile(join(input.inputDirectory, 'decisions.json'), 'utf8')) as {
      sessions: Array<{ inspectPath: string; noisePath: string }>;
    };
    expect(map.sessions).toHaveLength(1);
    const inspect = await readFile(join(input.inputDirectory, map.sessions[0]!.inspectPath), 'utf8');
    const noise = await readFile(join(input.inputDirectory, map.sessions[0]!.noisePath), 'utf8');
    expect(inspect.trim().split('\n')).toHaveLength(150);
    expect(noise.trim().split('\n')).toHaveLength(150);
    expect(noise).toContain('entry-299');
    expect(classify).toHaveBeenCalled();
    expect(captured?.thinkingLevel).toBe('medium');
  });

  it('keeps mixed text/tool-call inspect records in original JSONL instead of a lossy view', async () => {
    const input = await classifiedInputFor(await temporaryDirectory());
    const source = input.manifest.sessions[0]!;
    const transcriptPath = join(input.inputDirectory, source.transcriptPath);
    const transcript = (await readFile(transcriptPath, 'utf8')) + `${JSON.stringify({ type: 'message', id: 'mixed',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Read the incident.' },
        { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'incident.md' } }] },
    })}\n`;
    await writeFile(transcriptPath, transcript);
    const manifest = createMemoryInputManifest({ baseMemoryFingerprint: input.baseSnapshot.fingerprint,
      sessions: [{ ...source, materializedDigest: createHash('sha256').update(transcript).digest('hex'),
        byteLength: Buffer.byteLength(transcript) }],
    });
    const session = fakeSession();
    await createDefaultLocalMemoryDreamRunner({ createSession: async () => ({ session: session.session }) })({
      ...input, manifest, classifier: { canEvaluate: () => true, classify: async (state, questions) => ({
        answers: Object.fromEntries(Object.keys(questions).map((key, index) => [key, {
          type: 'choice' as const, choice: (state as { items: Array<{ content: string }> }).items[index]!.content === 'Routine status'
            ? 'noise' : 'inspect', confidence: 0.99,
        }])),
      }) },
    });
    const map = JSON.parse(await readFile(join(input.inputDirectory, 'decisions.json'), 'utf8')) as {
      sessions: Array<{ inspectPath: string; inspectViewPath?: string }>;
    };
    expect(map.sessions[0]?.inspectViewPath).toBeUndefined();
    const inspect = await readFile(join(input.inputDirectory, map.sessions[0]!.inspectPath), 'utf8');
    expect(inspect).toContain('A durable user choice');
    expect(inspect).toContain('call-1');
    expect(session.promptText).toContain('otherwise read inspectPath');
  });

  it('does not use low thinking when some transcript entries still need review', async () => {
    const input = await classifiedInputFor(await temporaryDirectory());
    const extra = [
      { type: 'message', id: 'second', message: { role: 'assistant', content: 'Needs verification.' } },
      { type: 'message', id: 'third', message: { role: 'assistant', content: 'Routine progress.' } },
    ].map((entry) => JSON.stringify(entry)).join('\n') + '\n';
    const transcriptPath = join(input.inputDirectory, input.manifest.sessions[0]!.transcriptPath);
    const transcript = (await readFile(transcriptPath, 'utf8')) + extra;
    await writeFile(transcriptPath, transcript);
    const manifest = createMemoryInputManifest({ baseMemoryFingerprint: input.baseSnapshot.fingerprint,
      sessions: [{ ...input.manifest.sessions[0]!, materializedDigest: createHash('sha256').update(transcript).digest('hex'),
        byteLength: Buffer.byteLength(transcript) }],
    });
    const session = fakeSession();
    let captured: Parameters<LocalMemoryDreamSessionFactory>[0] | undefined;
    await createDefaultLocalMemoryDreamRunner({ createSession: async (options) => {
      captured = options;
      return { session: session.session };
    } })({ ...input, manifest, classifier: { canEvaluate: () => true, classify: async (state: unknown, questions: Record<string, unknown>) => {
      const items = (state as { items: Array<{ provenance: string; content: string }> }).items;
      return { answers: Object.fromEntries(Object.keys(questions).map((key, index) => [key, {
        type: 'choice' as const, choice: items[index]?.provenance === 'user' ? 'inspect'
          : items[index]?.content === 'Routine status' || items[index]?.content === 'Routine progress.'
            ? 'noise' : 'inspect',
        confidence: items[index]?.content === 'Needs verification.' ? 0.3 : 0.99,
      }])) };
    } } });
    expect(captured?.thinkingLevel).toBe('medium');
    expect(session.promptText).toContain('read inspectViewPath');
    expect(JSON.parse(await readFile(join(input.inputDirectory, 'decisions.json'), 'utf8')))
      .toMatchObject({ version: 4 });
  });

  it('keeps the medium-thinking full-audit worker when classification fails or is unusable', async () => {
    for (const classify of [
      async () => { throw new Error('provider offline'); },
      async () => ({ answers: { item_0: { type: 'choice' as const, choice: 'noise', confidence: 0.2 } } }),
    ]) {
      const input = await classifiedInputFor(await temporaryDirectory());
      const session = fakeSession();
      let captured: Parameters<LocalMemoryDreamSessionFactory>[0] | undefined;
      await createDefaultLocalMemoryDreamRunner({ createSession: async (options) => {
        captured = options;
        return { session: session.session };
      } })({ ...input, classifier: { canEvaluate: () => true, classify } as Classifier });
      expect(captured?.thinkingLevel).toBe('medium');
      expect(captured?.appendSystemPrompt?.[0]).toContain('every listed transcript');
      expect(session.promptText).toContain('Read .dreaming/input/manifest.json and every transcript');
      await expect(readFile(join(input.inputDirectory, 'decisions.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('falls back to full audit if split evidence cannot be staged', async () => {
    const input = await classifiedInputFor(await temporaryDirectory());
    await writeFile(join(input.inputDirectory, 'sessions/000/inspect.jsonl'), 'already exists');
    const session = fakeSession();
    await createDefaultLocalMemoryDreamRunner({ createSession: async () => ({ session: session.session }) })({
      ...input,
      classifier: { canEvaluate: () => true, classify: async (_state, questions) => ({
        answers: Object.fromEntries(Object.keys(questions).map((key, index) => [key, {
          type: 'choice' as const, choice: index === 0 ? 'inspect' : 'noise', confidence: 0.99,
        }])),
      }) },
    });
    expect(session.promptText).toContain('every transcript listed by that manifest');
    await expect(readFile(join(input.inputDirectory, 'decisions.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('lets the worker recover supporting evidence from misclassified noise without mirroring routine output', async () => {
    const input = await classifiedInputFor(await temporaryDirectory());
    const source = input.manifest.sessions[0]!;
    const transcriptPath = join(input.inputDirectory, source.transcriptPath);
    const transcript = (await readFile(transcriptPath, 'utf8')) + [
      { type: 'message', id: 'incident', message: { role: 'user', content: 'Remember the unusual provider incident: see receipt-14 for the diagnostic.' } },
      { type: 'message', id: 'receipt-14', message: { role: 'toolResult', toolName: 'bash',
        content: 'receipt-14: provider acknowledged a queue commit but silently discarded it.' } },
    ].map((entry) => JSON.stringify(entry)).join('\n') + '\n';
    await writeFile(transcriptPath, transcript);
    const manifest = createMemoryInputManifest({ baseMemoryFingerprint: input.baseSnapshot.fingerprint,
      sessions: [{ ...source, materializedDigest: createHash('sha256').update(transcript).digest('hex'),
        byteLength: Buffer.byteLength(transcript) }],
    });
    const session = fakeSession();
    let recovered = false;
    const runner = createDefaultLocalMemoryDreamRunner({ createSession: async (options) => ({
      session: { ...session.session, prompt: async () => {
        const map = JSON.parse(await readFile(join(input.inputDirectory, 'decisions.json'), 'utf8')) as {
          sessions: Array<{ inspectPath: string; inspectViewPath?: string; noisePath: string }>;
        };
        const { inspectViewPath, noisePath } = map.sessions[0]!;
        expect(inspectViewPath).toBeDefined();
        const inspect = new TextDecoder().decode(await options.runtime.readFile(join(input.inputDirectory, inspectViewPath!)));
        expect(inspect).toContain('[source session="session-1" entry="incident" role=user]');
        expect(inspect).toContain('Remember the unusual provider incident');
        expect(inspect).not.toContain('silently discarded it');
        const grep = createRuntimeCodingTools(options.runtime).find(({ name }) => name === 'grep')!;
        const result = await grep.execute('lookup-receipt', { pattern: 'receipt-14',
          path: join(input.inputDirectory, noisePath), literal: true }, undefined, undefined, {} as never);
        recovered = JSON.stringify(result.content).includes('silently discarded it');
        if (!recovered) throw new Error('Missing supporting noise evidence');
        await options.runtime.mkdir('.memory/pages/incidents', { recursive: true });
        await options.runtime.writeFile('.memory/pages/incidents/provider.md', new TextEncoder().encode(
          '# Provider incident\n\nThe provider acknowledged a queue commit but silently discarded it.\n\n## Sources\n- session:session-1\n',
        ));
      } },
    }) });

    await runner({ ...input, manifest, classifier: { canEvaluate: () => true, classify: async (state, questions) => ({
      answers: Object.fromEntries(Object.keys(questions).map((key, index) => [key, {
        type: 'choice' as const, choice: (state as { items: Array<{ provenance: string }> }).items[index]!.provenance === 'user'
          ? 'inspect' : 'noise', confidence: 0.99,
      }])),
    }) } });
    expect(recovered).toBe(true);
    const retained = await readFile(join(input.stagingDirectory, '.memory/pages/incidents/provider.md'), 'utf8');
    expect(retained).toContain('silently discarded it');
    expect(retained).toContain('- session:session-1');
    expect(retained).not.toContain('Routine status');
  });

  it('cancels before creating the worker when classification aborts', async () => {
    const input = await classifiedInputFor(await temporaryDirectory());
    const abort = new AbortController();
    const createSession = vi.fn();
    const runner = createDefaultLocalMemoryDreamRunner({ createSession });
    await expect(runner({ ...input, signal: abort.signal, classifier: {
      canEvaluate: () => true,
      classify: async () => {
        abort.abort();
        return { answers: {} };
      },
    } })).rejects.toThrow('Memory processing was cancelled');
    expect(createSession).not.toHaveBeenCalled();
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
    await mkdir(join(stagingDirectory, '.dreaming', 'input', 'sessions'), { recursive: true });
    await writeFile(join(stagingDirectory, '.dreaming', 'input', 'sessions', 'noise.jsonl'), 'unique-noise-fact\n', 'utf8');
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
    expect(session.activeTools).toEqual(['read', 'ls', 'grep', 'edit', 'write', 'remove_memory_page']);
    expect(session.promptText).toContain('Read .dreaming/input/manifest.json');
    expect(session.promptText).toContain('Keep memory sparse');
    expect(session.promptText).toContain('direct user-authored durable facts');
    expect(session.promptText).toContain('not be cheaply recovered');
    expect(session.promptText).toContain('Delete old repository mirrors');
    expect(session.promptText).toContain('Use remove_memory_page');
    expect(session.promptText).not.toContain('Return only a JSON object');
    expect(session.disposed).toBe(true);

    const runtime = captured!.runtime;
    const grep = createRuntimeCodingTools(runtime).find(({ name }) => name === 'grep')!;
    const match = await grep.execute('search-noise', { pattern: 'unique-noise-fact',
      path: '.dreaming/input/sessions/noise.jsonl', literal: true }, undefined, undefined, {} as never);
    expect(JSON.stringify(match.content)).toContain('unique-noise-fact');
    const defaultMatch = await grep.execute('search-staged', { pattern: 'unique-noise-fact' },
      undefined, undefined, {} as never);
    expect(JSON.stringify(defaultMatch.content)).toContain('unique-noise-fact');
    const wikiMatch = await grep.execute('search-wiki', { pattern: 'existing memory', path: '.memory', literal: true },
      undefined, undefined, {} as never);
    expect(JSON.stringify(wikiMatch.content)).toContain('existing memory');
    await expect(grep.execute('search-private', { pattern: 'private', path: '.pi-memory-runtime' },
      undefined, undefined, {} as never)).rejects.toThrow('outside the staged memory inputs');
    await expect(runtime.exec('rg', ['--no-ignore', '--', 'private', '.dreaming/input']))
      .rejects.toThrow('does not permit process execution');
    await expect(runtime.exec('rg', ['--line-number', '--color=never', '--hidden', '--', 'private', '..']))
      .rejects.toThrow('escapes the staging directory');
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
  it('rejects an invalid cumulative input budget', async () => {
    await expect(materializeMemoryInput({
      stagingDirectory: await temporaryDirectory(),
      checkpoints: [],
      baseSnapshot: createMemorySnapshot(createEmptyMemoryArtifact('.memory'), '.memory'),
      maxInputBytes: 0,
    })).rejects.toThrow('Memory input byte limit must be a positive safe integer');
  });

  it('batches complete checkpoint deltas until reaching the cumulative input budget', async () => {
    const stagingDirectory = await temporaryDirectory();
    const checkpoints: SessionCheckpoint[] = [];
    for (let index = 0; index < 3; index += 1) {
      const sessionId = `session-${index + 1}`;
      const sessionFile = join(stagingDirectory, `${sessionId}.jsonl`);
      const entries = [sessionEntry('root', null, `Evidence ${index}. `.repeat(25_000))];
      await writeSessionFile(sessionFile, entries, sessionId);
      checkpoints.push(checkpointForEntries(sessionFile, entries, 'root', sessionId));
    }

    const result = await materializeMemoryInput({
      stagingDirectory,
      checkpoints,
      baseSnapshot: createMemorySnapshot(createEmptyMemoryArtifact('.memory'), '.memory'),
      maxInputBytes: 512 * 1024,
    });

    expect(result.failures).toEqual([]);
    expect(result.sessions.map(({ checkpoint }) => checkpoint.sessionId)).toEqual(['session-1', 'session-2']);
    expect(result.sessions.every(({ byteLength }) => byteLength > 256 * 1024)).toBe(true);
    expect(result.sessions.reduce((total, { byteLength }) => total + byteLength, 0)).toBeGreaterThanOrEqual(512 * 1024);
  });

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
      maxInputBytes: 10 * 1024 * 1024,
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

  it('keeps oversized active evidence pending without writing partial JSONL', async () => {
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
      maxInputBytes: 10 * 1024 * 1024,
      maxTranscriptBytes: 512,
    });

    expect(result.sessions).toEqual([]);
    expect(result.failures).toMatchObject([{
      code: 'output_too_large',
      checkpoint: { sessionId: 'session-1' },
    }]);
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
      maxInputBytes: 10 * 1024 * 1024,
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
      maxInputBytes: 10 * 1024 * 1024,
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

async function classifiedInputFor(stagingDirectory: string) {
  const input = inputFor(stagingDirectory, {
    modelRuntime: { getAvailableSnapshot: () => [{
      provider: 'test', id: 'test-mini', input: ['text'], reasoning: true,
    } as Model<Api>] } as unknown as ModelRuntime,
  });
  const transcript = `${JSON.stringify({
    type: 'message', id: 'first', parentId: null,
    message: { role: 'user', content: 'A durable user choice' },
  })}\n${JSON.stringify({ type: 'message', id: 'routine', parentId: 'first',
    message: { role: 'assistant', content: 'Routine status' } })}\n`;
  const materializedDigest = createHash('sha256').update(transcript).digest('hex');
  const manifest = createMemoryInputManifest({
    baseMemoryFingerprint: input.baseSnapshot.fingerprint,
    sessions: [{
      checkpoint: { sessionId: 'session-1', sessionFile: '/source/first.jsonl', leafId: 'routine', transcriptDigest: materializedDigest },
      metadataPath: 'sessions/000/metadata.json',
      transcriptPath: 'sessions/000/transcript.jsonl',
      materializedDigest,
      byteLength: Buffer.byteLength(transcript),
      redactionCount: 0,
    }],
  });
  const baseSnapshot = createMemorySnapshot([
    { path: 'summary.md', content: '# Summary\n\nOld useful preference.' },
    { path: 'index.md', content: '# Memory index\n\n## How to use this memory\n\n## Memory map' },
  ], '.memory', { mode: 'read' });
  const stagedManifest = createMemoryInputManifest({ baseMemoryFingerprint: baseSnapshot.fingerprint, sessions: manifest.sessions });
  await mkdir(join(input.inputDirectory, 'sessions/000'), { recursive: true });
  await writeFile(join(input.inputDirectory, 'sessions/000/transcript.jsonl'), transcript);
  await writeFile(join(input.inputDirectory, 'manifest.json'), JSON.stringify(stagedManifest));
  return { ...input, manifest: stagedManifest, baseSnapshot };
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

async function writeSessionFile(
  sessionFile: string,
  entries: readonly Record<string, unknown>[],
  sessionId = 'session-1',
): Promise<void> {
  await writeFile(sessionFile, [
    JSON.stringify({ type: 'session', version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: '/' }),
    ...entries.map((entry) => JSON.stringify(entry)),
    '',
  ].join('\n'), 'utf8');
}

function checkpointForEntries(
  sessionFile: string,
  entries: readonly Record<string, unknown>[],
  leafId: string,
  sessionId = 'session-1',
) {
  return {
    sessionId,
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
