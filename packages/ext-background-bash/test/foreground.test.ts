import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostAgentRuntime, type AgentRuntimeProcess, type AgentRuntimeStorage } from '@felan-ai/agent-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FOREGROUND_MAX_BYTES, RETAINED_SPILL_FILES, runForegroundCommand } from '../src/foreground.js';

const roots: string[] = [];
const processes: AgentRuntimeProcess[] = [];
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const TEST_TIMEOUT_MS = 15_000;

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(processes.splice(0).map((process) => process.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('runForegroundCommand', () => {
  it('returns short output and its exit code without changing the session storage tree', async () => {
    const { runtime, storage, spillDir } = await createRuntime();
    await storage.mkdir(join(storage.root, 'existing'));
    await storage.writeFile(join(storage.root, 'existing', 'keep.txt'), encoder.encode('keep'));
    const before = await storage.listFiles(storage.root, { recursive: true, includeDirectories: true });

    const result = await runForegroundCommand(runtime, "printf 'first\\nsecond\\n'", { timeoutMs: 5_000, storage, spillDir });

    expect(result).toEqual({ kind: 'exited', output: 'first\nsecond', exitCode: 0, truncated: false });
    expect(await storage.listFiles(storage.root, { recursive: true, includeDirectories: true })).toEqual(before);
    expect(decoder.decode(await storage.readFile(join(storage.root, 'existing', 'keep.txt')))).toBe('keep');
  });

  it('limits bytes and appends output received after creating the spill', async () => {
    const { runtime, storage, spillDir } = await createRuntime();
    const first = 'a'.repeat(FOREGROUND_MAX_BYTES + 1);
    const last = 'last chunk\n';
    mockOutput(runtime, [encoder.encode(first), encoder.encode(last)]);
    const result = await runForegroundCommand(runtime, 'command', { timeoutMs: 5_000, storage, spillDir });

    expect(result.kind).toBe('exited');
    if (result.kind !== 'exited') throw new Error('Expected an exited command');
    expect(result.truncated).toBe(true);
    expect(encoder.encode(result.output)).toHaveLength(FOREGROUND_MAX_BYTES);
    expect(result.output).toBe((first + last).slice(0, -1).slice(-FOREGROUND_MAX_BYTES));
    expect(decoder.decode(await storage.readFile(result.fullOutputPath!))).toBe(first + last);
  });

  it('does not split multi-byte UTF-8 characters at the byte limit', async () => {
    const { runtime, storage, spillDir } = await createRuntime();
    const output = '界'.repeat(30_000);
    const result = await runForegroundCommand(runtime, nodeCommand("process.stdout.write('界'.repeat(30000))"), { timeoutMs: 5_000, storage, spillDir });

    expect(result.kind).toBe('exited');
    if (result.kind !== 'exited') throw new Error('Expected an exited command');
    expect(result.truncated).toBe(true);
    expect(result.output).toBe('界'.repeat(Math.floor(FOREGROUND_MAX_BYTES / 3)));
    expect(result.output).not.toContain('\uFFFD');
    expect(encoder.encode(result.output).byteLength).toBeLessThanOrEqual(FOREGROUND_MAX_BYTES);
    expect(decoder.decode(await storage.readFile(result.fullOutputPath!))).toBe(output);
  });

  it.each(['界', '🌍'])('preserves the retained tail across chunks and split UTF-8 %s sequences', async character => {
    const { runtime, storage, spillDir } = await createRuntime();
    const output = encoder.encode(character.repeat(80_000) + '\r\n');
    const chunks = [output.subarray(0, 130_001), output.subarray(130_001, 170_000), output.subarray(170_000)];
    mockOutput(runtime, chunks);

    const result = await runForegroundCommand(runtime, 'command', { timeoutMs: 5_000, storage, spillDir });

    expect(result).toMatchObject({ kind: 'exited', exitCode: 0, truncated: true, output: character.repeat(Math.floor(FOREGROUND_MAX_BYTES / encoder.encode(character).byteLength)) });
  });

  it('keeps decoded replacement characters within the byte limit for invalid UTF-8', async () => {
    const { runtime, storage, spillDir } = await createRuntime();
    mockOutput(runtime, [new Uint8Array(3 * FOREGROUND_MAX_BYTES).fill(0xff)]);

    const result = await runForegroundCommand(runtime, 'command', { timeoutMs: 5_000, storage, spillDir });

    expect(result).toMatchObject({ kind: 'exited', exitCode: 0, truncated: true, output: '\uFFFD'.repeat(Math.floor(FOREGROUND_MAX_BYTES / 3)) });
  });

  it.each(['mkdir', 'writeFile', 'appendFile', 'later append'] as const)('preserves output and exit status after a spill %s failure', async operation => {
    const { runtime, storage, spillDir } = await createRuntime();
    const chunks = [encoder.encode('a'.repeat(FOREGROUND_MAX_BYTES)), encoder.encode('b'), encoder.encode('c'), encoder.encode('done\n')];
    const child = mockOutput(runtime, chunks, 7);
    const method = operation === 'later append' ? 'appendFile' : operation;
    const original = storage[method].bind(storage);
    let calls = 0;
    const failingCall = operation === 'later append' ? 2 : 1;
    vi.spyOn(storage, method).mockImplementation(async (...args: Parameters<typeof original>) => {
      if (++calls === failingCall) throw new Error('Storage unavailable');
      return Reflect.apply(original, storage, args);
    });

    const result = await runForegroundCommand(runtime, 'command', { timeoutMs: 5_000, storage, spillDir });

    expect(result).toEqual({ kind: 'exited', exitCode: 7, truncated: true, output: 'a'.repeat(FOREGROUND_MAX_BYTES - 6) + 'bcdone' });
    expect(child.terminate).not.toHaveBeenCalled();
    expect(child.dispose).toHaveBeenCalledOnce();
  });

  it('hands a live process back at the deadline without disposing it', async () => {
    const { runtime, storage, spillDir } = await createRuntime();
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const child = mockOutput(runtime, []);
    vi.mocked(child.read).mockImplementationOnce(async () => {
      now.mockReturnValue(1_020);
      return { output: new Uint8Array(), nextOffset: 0, running: true };
    });
    const result = await runForegroundCommand(runtime, 'command', { timeoutMs: 20, storage, spillDir });

    expect(result.kind).toBe('timeout');
    if (result.kind !== 'timeout') throw new Error('Expected a timeout');
    expect(result.startedAt).toBe(1_000);
    expect(result.process).toBe(child);
    expect(child.terminate).not.toHaveBeenCalled();
    expect(child.dispose).not.toHaveBeenCalled();
    vi.mocked(child.read).mockResolvedValue({ output: encoder.encode('done'), nextOffset: 4, running: false, exitCode: 7 });
    expect(await result.process.read(0)).toMatchObject({ output: encoder.encode('done'), running: false, exitCode: 7 });
    await result.process.dispose();
  });

  it.each(['before', 'during'])('terminates and disposes when aborted %s the read loop', async (when) => {
    const { runtime, storage, spillDir } = await createRuntime();
    const controller = new AbortController();
    let running = true;
    const child: AgentRuntimeProcess = {
      pid: undefined,
      read: vi.fn(async () => {
        if (when === 'during') controller.abort();
        return { output: new Uint8Array(), nextOffset: 0, running };
      }),
      write: vi.fn(async () => {}),
      terminate: vi.fn(async () => { running = false; }),
      dispose: vi.fn(async () => {}),
    };
    vi.mocked(runtime.processes!.startShell).mockResolvedValue(child);
    if (when === 'before') controller.abort();

    await expect(runForegroundCommand(runtime, 'command', { timeoutMs: 5_000, storage, spillDir, signal: controller.signal }))
      .rejects.toThrow('Command cancelled');

    expect(child.terminate).toHaveBeenCalledWith('SIGTERM');
    expect(child.dispose).toHaveBeenCalled();
    expect(running).toBe(false);
  });

  it('prunes only the oldest spill files down to the newest 20 names', async () => {
    const { runtime, storage, spillDir } = await createRuntime();
    await storage.mkdir(spillDir, { recursive: true });
    const oldFiles = Array.from({ length: 23 }, (_, index) => `output-20200101000000-${index.toString(16).padStart(6, '0')}.log`);
    await Promise.all([...oldFiles, 'keep.txt'].map((file) => storage.writeFile(join(spillDir, file), encoder.encode(file))));

    const result = await runForegroundCommand(runtime, nodeCommand(`process.stdout.write('a'.repeat(${FOREGROUND_MAX_BYTES + 1}))`), { timeoutMs: 5_000, storage, spillDir });

    expect(result.kind).toBe('exited');
    if (result.kind !== 'exited') throw new Error('Expected an exited command');
    const files = await storage.listFiles(spillDir, { pattern: 'output-*.log' });
    expect(files).toHaveLength(RETAINED_SPILL_FILES);
    expect(files).toEqual([...oldFiles.slice(4), result.fullOutputPath!.slice(spillDir.length + 1)].sort());
    expect(await storage.listFiles(spillDir)).toContain('keep.txt');
  });
}, TEST_TIMEOUT_MS);

async function createRuntime(): Promise<{ runtime: HostAgentRuntime; storage: AgentRuntimeStorage; spillDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'felan-foreground-'));
  roots.push(root);
  const cwd = join(root, 'workspace');
  const sessionStorageRoot = join(root, 'session-storage');
  const agentStorageRoot = join(root, 'agent-storage');
  await Promise.all([cwd, sessionStorageRoot, agentStorageRoot].map((path) => mkdir(path, { recursive: true })));
  const runtime = new HostAgentRuntime(cwd, { sessionStorageRoot, agentStorageRoot });
  const start = runtime.processes!.startShell.bind(runtime.processes);
  vi.spyOn(runtime.processes!, 'startShell').mockImplementation(async (command, options) => {
    const process = await start(command, options);
    processes.push(process);
    return process;
  });
  return { runtime, storage: runtime.storage('session'), spillDir: join(sessionStorageRoot, 'spills') };
}

function mockOutput(runtime: HostAgentRuntime, chunks: Uint8Array[], exitCode = 0): AgentRuntimeProcess {
  let index = 0;
  let offset = 0;
  const child = {
    read: vi.fn(async () => {
      const output = chunks[index++] ?? new Uint8Array();
      offset += output.byteLength;
      return { output, nextOffset: offset, running: output.byteLength > 0, exitCode };
    }),
    terminate: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  } as unknown as AgentRuntimeProcess;
  vi.mocked(runtime.processes!.startShell).mockResolvedValue(child);
  return child;
}

function nodeCommand(source: string): string {
  return `'${process.execPath.replaceAll("'", "'\\''")}' -e '${source.replaceAll("'", "'\\''")}'`;
}
