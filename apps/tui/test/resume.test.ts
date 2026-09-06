import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { openLocalSessionManager } from '../src/resume.js';

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe('local session resume', () => {
  it('opens the exact stored session with its original working directory', async () => {
    const root = await temporaryDirectory();
    const sessionDir = join(root, 'sessions');
    const storedCwd = join(root, 'stored-project');
    await Promise.all([sessionDir, storedCwd].map((path) => mkdir(path, { recursive: true })));
    const stored = SessionManager.create(storedCwd, sessionDir);
    stored.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: 'resume me' }],
      timestamp: Date.now(),
    });
    stored.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'ready' }],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'test-model',
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: Date.now(),
    });

    const opened = await openLocalSessionManager(stored.getSessionId(), sessionDir);

    expect(opened.getSessionId()).toBe(stored.getSessionId());
    expect(opened.getCwd()).toBe(storedCwd);
    expect(opened.getSessionFile()).toBe(stored.getSessionFile());
  });

  it('rejects an unknown session id', async () => {
    const root = await temporaryDirectory();
    const sessionDir = join(root, 'sessions');
    await mkdir(sessionDir, { recursive: true });

    await expect(openLocalSessionManager('missing', sessionDir)).rejects.toThrow(
      "No session found matching 'missing'",
    );
  });

  it('keeps explicit resume discovery flat while the picker separately discovers nested memory sessions', async () => {
    const root = await temporaryDirectory();
    const sessionDir = join(root, 'sessions');
    const project = join(root, 'project');
    await Promise.all([mkdir(join(sessionDir, 'memory'), { recursive: true }), mkdir(project)]);
    const memory = SessionManager.create(project, join(sessionDir, 'memory'));
    memory.appendMessage({ role: 'user', content: 'retained input', timestamp: Date.now() });
    memory.appendMessage({
      role: 'assistant', content: [{ type: 'text', text: 'retained output' }],
      api: 'anthropic-messages', provider: 'anthropic', model: 'test-model', stopReason: 'stop', timestamp: Date.now(),
      usage: {
        input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });

    await expect(openLocalSessionManager(memory.getSessionId(), sessionDir)).rejects.toThrow(
      `No session found matching '${memory.getSessionId()}'`,
    );
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'felan-tui-resume-'));
  temporaryPaths.push(path);
  return path;
}
