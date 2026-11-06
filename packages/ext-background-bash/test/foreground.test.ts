import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostAgentRuntime, type AgentRuntimeProcess, type AgentRuntimeStorage } from '@felan-ai/agent-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FOREGROUND_MAX_BYTES, FOREGROUND_MAX_LINES, RETAINED_SPILL_FILES, runForegroundCommand } from '../src/foreground.js';

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
    const start = vi.spyOn(runtime.processes!, 'startShell');
    const write = vi.spyOn(storage, 'writeFile');
    const append = vi.spyOn(storage, 'appendFile');
    const makeDirectory = vi.spyOn(storage, 'mkdir');
    const getStorage = vi.spyOn(runtime, 'storage');

    const result = await runForegroundCommand(runtime, "printf 'first\\nsecond\\n'", { timeoutMs: 5_000, storage, spillDir });

    expect(result).toEqual({ kind: 'exited', output: 'first\nsecond', exitCode: 0, truncated: false });
    expect(start).toHaveBeenCalledWith("printf 'first\\nsecond\\n'", { cwd: runtime.cwd, shellFlavor: 'posix', login: false });
    expect(await storage.listFiles(storage.root, { recursive: true, includeDirectories: true })).toEqual(before);
    expect(decoder.decode(await storage.readFile(join(storage.root, 'existing', 'keep.txt')))).toBe('keep');
    expect(write).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
    expect(makeDirectory).not.toHaveBeenCalled();
    expect(getStorage).not.toHaveBeenCalled();
  });

  it('returns a non-zero exit code', async () => {
    const { runtime, storage, spillDir } = await createRuntime();
    await expect(runForegroundCommand(runtime, "printf 'failed'; exit 7", { timeoutMs: 5_000, storage, spillDir }))
      .resolves.toEqual({ kind: 'exited', output: 'failed', exitCode: 7, truncated: false });
  });

  it('keeps the last 2000 lines and spills every line', async () => {
    const { runtime, storage, spillDir } = await createRuntime();
    const output = Array.from({ length: 3000 }, (_, index) => `line ${index + 1}`).join('\n') + '\n';
    const result = await runForegroundCommand(runtime, printCommand(output), { timeoutMs: 5_000, storage, spillDir });

    expect(result.kind).toBe('exited');
    if (result.kind !== 'exited') throw new Error('Expected an exited command');
    expect(result.truncated).toBe(true);
    expect(result.output.split('\n')).toHaveLength(FOREGROUND_MAX_LINES);
    expect(result.output).toBe(output.trimEnd().split('\n').slice(-FOREGROUND_MAX_LINES).join('\n'));
    expect(result.fullOutputPath).toMatch(/\/output-\d{14}-[a-f0-9]{6}\.log$/u);
    expect(decoder.decode(await storage.readFile(result.fullOutputPath!))).toBe(output);
  });

  it('limits bytes and appends output received after creating the spill', async () => {
    const { runtime, storage, spillDir } = await createRuntime();
    const first = 'a'.repeat(FOREGROUND_MAX_BYTES + 1);
    const last = 'last chunk\n';
    const command = nodeCommand(`process.stdout.write('a'.repeat(${first.length})); setTimeout(() => process.stdout.write(${JSON.stringify(last)}), 80);`);
    const result = await runForegroundCommand(runtime, command, { timeoutMs: 5_000, storage, spillDir });

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

  it.each(['界', '🌍'])('decodes the retained byte tail once after trimming chunks and split UTF-8 %s sequences', async character => {
    const { runtime, storage, spillDir } = await createRuntime();
    const output = encoder.encode(character.repeat(80_000) + '\r\n');
    const chunks = [output.subarray(0, 130_001), output.subarray(130_001, 170_000), output.subarray(170_000)];
    mockOutput(runtime, chunks);
    const decode = vi.spyOn(TextDecoder.prototype, 'decode');

    const result = await runForegroundCommand(runtime, 'command', { timeoutMs: 5_000, storage, spillDir });

    expect(result).toMatchObject({ kind: 'exited', exitCode: 0, truncated: true, output: character.repeat(Math.floor(FOREGROUND_MAX_BYTES / encoder.encode(character).byteLength)) });
    expect(decode).toHaveBeenCalledOnce();
  });

  it('keeps decoded replacement characters within the byte limit for invalid UTF-8', async () => {
    const { runtime, storage, spillDir } = await createRuntime();
    mockOutput(runtime, [new Uint8Array(3 * FOREGROUND_MAX_BYTES).fill(0xff)]);

    const result = await runForegroundCommand(runtime, 'command', { timeoutMs: 5_000, storage, spillDir });

    expect(result).toMatchObject({ kind: 'exited', exitCode: 0, truncated: true, output: '\uFFFD'.repeat(Math.floor(FOREGROUND_MAX_BYTES / 3)) });
  });

  it.each(['mkdir', 'writeFile', 'appendFile', 'later append'] as const)('continues after a spill %s failure without retrying', async operation => {
    const { runtime, storage, spillDir } = await createRuntime();
    const chunks = [encoder.encode('a'.repeat(FOREGROUND_MAX_BYTES)), encoder.encode('b'), encoder.encode('c'), encoder.encode('done\n')];
    const child = mockOutput(runtime, chunks, 7);
    const method = operation === 'later append' ? 'appendFile' : operation;
    const original = storage[method].bind(storage);
    let calls = 0;
    const failingCall = operation === 'later append' ? 2 : 1;
    const failure = vi.spyOn(storage, method).mockImplementation(async (...args: Parameters<typeof original>) => {
      if (++calls === failingCall) throw new Error('Storage unavailable');
      return Reflect.apply(original, storage, args);
    });

    const result = await runForegroundCommand(runtime, 'command', { timeoutMs: 5_000, storage, spillDir });

    expect(result).toEqual({ kind: 'exited', exitCode: 7, truncated: true, output: 'a'.repeat(FOREGROUND_MAX_BYTES - 6) + 'bcdone' });
    expect(failure).toHaveBeenCalledTimes(failingCall);
    expect(child.read).toHaveBeenCalledTimes(chunks.length + 1);
    expect(child.terminate).not.toHaveBeenCalled();
    expect(child.dispose).toHaveBeenCalledOnce();
  });

  it('accepts an infinite timeout', async () => {
    const { runtime, storage, spillDir } = await createRuntime();
    await expect(runForegroundCommand(runtime, "printf 'done'", { timeoutMs: Infinity, storage, spillDir }))
      .resolves.toEqual({ kind: 'exited', output: 'done', exitCode: 0, truncated: false });
  });

  it.each([0, -1, -Infinity, NaN])('rejects an invalid timeout %s before starting a process', async timeoutMs => {
    const { runtime, storage, spillDir } = await createRuntime();
    await expect(runForegroundCommand(runtime, 'command', { timeoutMs, storage, spillDir })).rejects.toThrow('timeoutMs must be positive');
    expect(runtime.processes!.startShell).not.toHaveBeenCalled();
  });

  it('hands a live process back at the deadline without disposing it', async () => {
    const { runtime, storage, spillDir } = await createRuntime();
    const before = Date.now();
    const result = await runForegroundCommand(runtime, "sleep 0.2; printf 'done'; exit 7", { timeoutMs: 20, storage, spillDir });

    expect(result.kind).toBe('timeout');
    if (result.kind !== 'timeout') throw new Error('Expected a timeout');
    expect(result.startedAt).toBeGreaterThanOrEqual(before);
    expect(await result.process.read(0)).toMatchObject({ running: true });
    let offset = 0;
    let output = '';
    while (true) {
      const snapshot = await result.process.read(offset, { waitMs: 1_000 });
      output += decoder.decode(snapshot.output);
      offset = snapshot.nextOffset;
      if (!snapshot.running) {
        expect(snapshot.exitCode).toBe(7);
        break;
      }
    }
    expect(output).toBe('done');
    await result.process.dispose();
  });

  it.each(['before', 'during'])('terminates and disposes when aborted %s the read loop', async (when) => {
    const { runtime, storage, spillDir } = await createRuntime();
    const controller = new AbortController();
    const start = vi.mocked(runtime.processes!.startShell).getMockImplementation()!;
    let child: AgentRuntimeProcess | undefined;
    let terminate: ReturnType<typeof vi.spyOn> | undefined;
    let dispose: ReturnType<typeof vi.spyOn> | undefined;
    vi.spyOn(runtime.processes!, 'startShell').mockImplementation(async (command, options) => {
      child = await start(command, options);
      terminate = vi.spyOn(child, 'terminate');
      dispose = vi.spyOn(child, 'dispose');
      if (when === 'during') setTimeout(() => controller.abort(), 40);
      return child;
    });
    if (when === 'before') controller.abort();

    await expect(runForegroundCommand(runtime, 'sleep 30', { timeoutMs: 5_000, storage, spillDir, signal: controller.signal }))
      .rejects.toThrow('Command cancelled');

    expect(terminate).toHaveBeenCalledWith('SIGTERM');
    expect(dispose).toHaveBeenCalled();
    expect(await child!.read(0)).toMatchObject({ running: false });
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

function printCommand(output: string): string {
  return nodeCommand(`process.stdout.write(${JSON.stringify(output)});`);
}
