import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import {
  initTheme,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import { Key, TuiAltScreen, type Terminal, type TUI, type TuiMouseEvent } from '@earendil-works/pi-tui';
import { HostAgentRuntime, type SessionsService } from '@felan-ai/agent-core';
import { listLocalSessionHistory as listHistory, readMemoryHistorySnapshot as readSnapshot, localMemoryProjectDirectory, resolveLocalMemoryProject as resolveProject, MEMORY_RUN_ENTRY, type MemoryRunMetadata, type LocalSessionHistory } from '@felan-ai/ext-memory';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
const environment = { runtime: new HostAgentRuntime('/', { pathAccess: 'host', sessionStorageRoot: tmpdir(), agentStorageRoot: tmpdir() }), sessions: {} as SessionsService };
const listLocalSessionHistory = (options: Parameters<typeof listHistory>[1]) => listHistory(environment, options);
const readMemoryHistorySnapshot = (session: Parameters<typeof readSnapshot>[1]) => readSnapshot(environment, session);
const resolveLocalMemoryProject = (cwd: string) => resolveProject(environment, cwd);
import { MemoryHistoryView } from '../src/memory/history-renderer.js';

const temporaryPaths: string[] = [];
const execFileAsync = promisify(execFile);

beforeAll(() => initTheme('dark', false));

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('local memory history', () => {

  it.skipIf(process.platform === 'win32')('skips symlinks and FIFOs during bounded history discovery', async () => {
    const fixture = await memoryFixture();
    const memoryDir = join(fixture.sessionDir, 'memory');
    const outside = join(dirname(memoryDir), 'outside.jsonl');
    await writeFile(outside, await readFile(fixture.memoryFile));
    await symlink(outside, join(memoryDir, 'linked.jsonl'));
    await execFileAsync('mkfifo', [join(memoryDir, 'pipe.jsonl')]);
    const oversized = join(memoryDir, 'oversized.jsonl');
    await writeFile(oversized, `${JSON.stringify({
      type: 'session', version: 3, id: 'oversized', timestamp: '2026-09-01T12:00:00.000Z', cwd: fixture.cwd,
    })}\n${'x'.repeat(512 * 1_024)}`);

    const history = await listLocalSessionHistory({ ...fixture, memoryOnly: true });

    expect([...history.memorySessions.keys()]).toContain(fixture.memoryFile);
    expect([...history.memorySessions.keys()]).toContain(oversized);
    expect([...history.memorySessions.keys()]).not.toContain(join(memoryDir, 'linked.jsonl'));
    expect([...history.memorySessions.keys()]).not.toContain(join(memoryDir, 'pipe.jsonl'));
  });

  it('inspects a retained transcript read-only and returns to the picker', async () => {
    const fixture = await memoryFixture();
    const listed = await listLocalSessionHistory({ ...fixture, memoryOnly: true });
    const memory = listed.memorySessions.get(fixture.memoryFile)!;
    const history: LocalSessionHistory = {
      currentSessions: [memory],
      allSessions: [memory],
      memorySessions: new Map([[memory.path, memory]]),
    };
    const tui = fakeTui();
    const done = vi.fn();
    const openSession = vi.spyOn(SessionManager, 'open');
    const before = await readFile(fixture.memoryFile, 'utf8');
    const view = new MemoryHistoryView(tui, history, done, { readSnapshot: readMemoryHistorySnapshot });

    expect(view.render(120).join('\n')).toContain('Memory: workspace · failed');
    view.handleInput(keyData(Key.enter));
    await vi.waitFor(() => expect(view.render(120).join('\n')).toContain('Retained response'));
    const output = view.render(120).join('\n');
    expect(output).toContain('read-only');
    expect(output).toContain('Retained request');
    expect(output).toContain('Retained response');
    expect(output).toContain('Bearer [REDACTED_TOKEN]');
    expect(output).not.toContain('abcdefghijklmnop');
    expect(openSession).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();

    view.handleInput(keyData(Key.escape));
    expect(view.render(120).join('\n')).toContain('Resume Session');
    expect(await readFile(fixture.memoryFile, 'utf8')).toBe(before);
    view.dispose();
  });

  it('explains a retained run that stopped before an assistant response', async () => {
    const fixture = await memoryFixture();
    const entries = (await readFile(fixture.memoryFile, 'utf8')).trim().split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.type !== 'message'
        || (entry.message as { role?: unknown } | undefined)?.role !== 'assistant');
    await writeFile(fixture.memoryFile, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
    const listed = await listLocalSessionHistory({ ...fixture, memoryOnly: true });
    const memory = listed.memorySessions.get(fixture.memoryFile)!;
    const tui = fakeTui();
    const view = new MemoryHistoryView(tui, {
      currentSessions: [memory], allSessions: [memory], memorySessions: new Map([[memory.path, memory]]),
    }, vi.fn(), { readSnapshot: readMemoryHistorySnapshot });

    view.handleInput(keyData(Key.enter));
    await vi.waitFor(() => expect(view.render(120).join('\n')).toContain('No assistant response was retained.'));
    view.dispose();
  });

  it('scrolls a retained transcript one line per normalized wheel event', async () => {
    const tui = fakeTui();
    const view = await scrollableMemoryView(tui);
    try {
      const first = view.render(80);
      view.handleInput('\x1b[B');
      const afterOneLine = view.render(80);
      expect(afterOneLine).not.toEqual(first);
      view.handleInput('\x1b[H');
      vi.mocked(tui.requestRender).mockClear();

      expect(view.handleMouse({ ...wheelEvent(0), type: 'press', button: 'left' })).toBeUndefined();
      expect(tui.requestRender).not.toHaveBeenCalled();
      expect(view.handleMouse(wheelEvent(4))).toEqual({ handled: true });
      expect(view.render(80)).toEqual(afterOneLine);

      expect(view.handleMouse(wheelEvent(-1))).toEqual({ handled: true });
      expect(view.render(80)).toEqual(first);
      expect(tui.requestRender).not.toHaveBeenCalled();
    } finally {
      view.dispose();
    }
    vi.mocked(tui.requestRender).mockClear();
    expect(view.handleMouse(wheelEvent(1))).toBeUndefined();
    expect(tui.requestRender).not.toHaveBeenCalled();
  });

  it.each([
    ['SGR', '\x1b[<64;20;5M', '\x1b[<65;20;5M'],
    ['legacy', '\x1b[M' + String.fromCharCode(64 + 32, 52, 37), '\x1b[M' + String.fromCharCode(65 + 32, 52, 37)],
  ])('receives %s wheel input through a focused fullscreen TUI overlay', async (_protocol, wheelUp, wheelDown) => {
    const terminal = new TestTerminal();
    const tui = new TuiAltScreen(terminal);
    const view = await scrollableMemoryView(tui);
    tui.showOverlay(view, { width: '100%', maxHeight: '100%', margin: 0 });
    tui.start();
    try {
      tui.renderNow(true);
      const first = view.render(terminal.columns);
      const requestRender = vi.spyOn(tui, 'requestRender');
      expect(tui.isOverlayFocused()).toBe(true);

      terminal.send(wheelDown);
      expect(view.render(terminal.columns)).not.toEqual(first);
      expect(requestRender).toHaveBeenCalledOnce();

      terminal.send(wheelUp);
      expect(view.render(terminal.columns)).toEqual(first);
      expect(requestRender).toHaveBeenCalledTimes(2);
    } finally {
      view.dispose();
      tui.stop();
    }
  });
});

async function scrollableMemoryView(tui: TUI): Promise<MemoryHistoryView> {
  const fixture = await memoryFixture();
  const history = await listLocalSessionHistory({ ...fixture, memoryOnly: true });
  const memory = history.memorySessions.get(fixture.memoryFile)!;
  const snapshot = await readMemoryHistorySnapshot(memory);
  return new MemoryHistoryView(tui, history, vi.fn(), {
    memoryOnly: true,
    snapshot: {
      ...snapshot,
      messages: [{
        role: 'user',
        content: Array.from({ length: 40 }, (_, index) => `Transcript line ${index + 1}`).join('\n'),
        timestamp: 1,
      }],
    },
  });
}

function wheelEvent(wheelDelta: number): TuiMouseEvent {
  return {
    type: 'wheel', button: 'none', wheelDelta,
    x: 19, y: 4, screenX: 19, screenY: 4, width: 80, height: 12,
    shift: false, alt: false, ctrl: false,
  };
}

class TestTerminal implements Terminal {
  readonly columns = 80;
  readonly rows = 12;
  readonly kittyProtocolActive = false;
  #onInput?: (data: string) => void;

  start(onInput: (data: string) => void): void { this.#onInput = onInput; }
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(): void {}
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgramStatus(): void {}
  setProgress(): void {}
  send(data: string): void { this.#onInput?.(data); }
}

async function memoryFixture() {
  const root = await temporaryDirectory();
  const projectRoot = join(root, 'workspace');
  const sessionDir = join(root, 'sessions');
  const memoryDir = join(sessionDir, 'memory');
  const agentDir = join(root, 'agent');
  await Promise.all([mkdir(projectRoot), mkdir(memoryDir, { recursive: true })]);
  const project = await resolveLocalMemoryProject(projectRoot);
  const normal = SessionManager.create(project.canonicalRoot, sessionDir);
  appendUser(normal, 'Ordinary request');
  appendAssistant(normal, 'Ordinary response');
  const memory = SessionManager.create(project.canonicalRoot, memoryDir);
  const memoryFile = memory.getSessionFile()!;
  const error = 'Bearer abcdefghijklmnop\u001b]8;;https://example.test\u0007hidden\u001b]8;;\u0007';
  const metadata: MemoryRunMetadata = {
    ...await metadataFor(memory, agentDir, project.canonicalRoot),
    status: 'started',
    phase: 'materialize',
  };
  memory.appendSessionInfo('Memory: workspace');
  memory.appendCustomEntry(MEMORY_RUN_ENTRY, metadata);
  appendUser(memory, 'Retained request');
  appendAssistant(memory, 'Retained response');
  const finished: MemoryRunMetadata = {
    ...metadata,
    status: 'failed',
    phase: 'model',
    finishedAt: '2026-09-01T12:01:00.000Z',
    error,
  };
  memory.appendCustomEntry(MEMORY_RUN_ENTRY, finished);
  const runDirectory = join(localMemoryProjectDirectory(agentDir, project), 'runs', memory.getSessionId());
  await mkdir(runDirectory, { recursive: true });
  await writeFile(join(runDirectory, 'manifest.json'), JSON.stringify(finished));
  return {
    cwd: project.canonicalRoot,
    projectRoot,
    agentDir,
    sessionDir,
    project,
    normal,
    normalFile: normal.getSessionFile()!,
    memory,
    memoryFile,
    error,
  };
}

async function metadataFor(
  session: SessionManager,
  _agentDir: string,
  projectRoot: string,
): Promise<MemoryRunMetadata> {
  const project = await resolveLocalMemoryProject(projectRoot);
  return {
    version: 1,
    kind: 'memory',
    sessionId: session.getSessionId(),
    sessionFile: basename(session.getSessionFile()!),
    projectKey: project.key,
    projectRoot: project.canonicalRoot,
    startedAt: '2026-09-01T12:00:00.000Z',
    status: 'completed',
    phase: 'publish',
    checkpoints: [],
    baseFingerprint: '1'.repeat(64),
  };
}

function appendUser(session: SessionManager, text: string): void {
  session.appendMessage({ role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() });
}

function appendAssistant(session: SessionManager, text: string): void {
  session.appendMessage({
    role: 'assistant',
    content: [{ type: 'text', text }],
    provider: 'openai',
    model: 'fixture-model',
    api: 'openai-responses',
    stopReason: 'stop',
    timestamp: Date.now(),
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
}

async function temporaryDirectory(prefix = 'felan-memory-history-'): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryPaths.push(path);
  return path;
}

function fakeTui(): TUI {
  return {
    terminal: { rows: 32 },
    requestRender: vi.fn(),
  } as unknown as TUI;
}

function keyData(key: string): string {
  const values: Record<string, string> = {
    enter: '\r',
    escape: '\u001b',
  };
  const data = values[key];
  if (!data) throw new Error(`Missing test key data for ${key}`);
  return data;
}
