import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostAgentRuntime, type AgentRuntime, type AgentRuntimeStorage } from '@felan-ai/agent-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readLogTail } from '../src/logs.js';

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('readLogTail', () => {
  it('passes a hard read bound and preserves short-log behavior', async () => {
    let options: unknown;
    const storage = {
      root: '/state',
      async readFile(_path: string, readOptions?: unknown) {
        options = readOptions;
        return new TextEncoder().encode('first\nsecond\n');
      },
    } as unknown as AgentRuntimeStorage;

    await expect(readLogTail({ shell: vi.fn<AgentRuntime['shell']>() }, storage, '/state/output.log'))
      .resolves.toBe('first\nsecond');
    expect(options).toEqual({ maxBytes: 128 * 1024 });
  });

  it.each(['\n', '\r\n', ''])('returns the last line of a large log ending in %j', async (ending) => {
    const fixture = await logFixture('old line\n'.repeat(40_000) + `FINAL 🌍${ending}`);
    const output = await fixture.tail(1);
    expect(output).toMatch(/\nFINAL 🌍$/u);
    expect(output).not.toContain('old line');
    expect(fixture.readFile).toHaveBeenCalledWith(fixture.path, { maxBytes: 128 * 1024 });
    expect(fixture.shell).toHaveBeenCalledWith(
      expect.stringContaining('tail -c'),
      expect.objectContaining({ shellFlavor: 'posix', maxOutputBytes: expect.any(Number) }),
    );
    expect(fixture.shell.mock.calls[0]![1]!.maxOutputBytes).toBeLessThan(129 * 1024);
  });

  it('does not count the final newline as an extra log line', async () => {
    const fixture = await logFixture('first\nsecond\nthird\n');
    expect(await fixture.tail(2)).toMatch(/\nsecond\nthird$/u);
  });

  it.each([0, 1, 2, 3])('bounds a long single line without splitting UTF-8 at offset %i', async (offset) => {
    const fixture = await logFixture('😀'.repeat(40_000) + 'x'.repeat(offset) + 'FINAL 🌍\n');
    const output = await fixture.tail(1);
    const body = output.slice(output.indexOf('\n') + 1);
    expect(body).toMatch(/FINAL 🌍$/u);
    expect(body).not.toContain('\uFFFD');
    expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(128 * 1024);
    expect(body.length).toBeGreaterThan(10);
  });

  it('quotes shell-sensitive log paths', async () => {
    const fixture = await logFixture('old\n'.repeat(40_000) + 'SAFE\n', "output ' $(echo unsafe);.log");
    expect(await fixture.tail(1)).toMatch(/\nSAFE$/u);
  });

  it('provides the process view with 2,000 trailing lines', async () => {
    const fixture = await logFixture('old line\n'.repeat(40_000) + 'FINAL\n');
    const output = await fixture.tail(2_000);
    expect(output.split('\n').slice(1)).toHaveLength(2_000);
    expect(output).toMatch(/\nFINAL$/u);
  });

  it('preserves empty and missing log results without invoking a shell', async () => {
    const fixture = await logFixture('');
    expect(await fixture.tail(1)).toBe('(log is empty)');
    await rm(fixture.path);
    expect(await fixture.tail(1)).toBe('(log file not found)');
    expect(fixture.shell).not.toHaveBeenCalled();
  });

  it('does not bypass storage access failures', async () => {
    const fixture = await logFixture('');
    fixture.readFile.mockRejectedValue(new Error('Path escapes storage root'));
    await expect(fixture.tail(1)).rejects.toThrow('Path escapes storage root');
    expect(fixture.shell).not.toHaveBeenCalled();
  });

  it.each([
    { result: { code: 1, stderr: 'tail: access denied', killed: false }, error: 'tail: access denied' },
    { result: { code: 0, stderr: '', killed: true }, error: 'timed out or was terminated' },
    { result: { code: 0, stderr: '', killed: false, truncated: true }, error: 'exceeded its read bound' },
  ])('surfaces tail failure: $error', async ({ result, error }) => {
    const fixture = await logFixture('x'.repeat(140_000));
    fixture.shell.mockResolvedValue({ stdout: '', ...result });
    await expect(fixture.tail(1)).rejects.toThrow(error);
  });
});

async function logFixture(content: string, name = 'output.log') {
  const root = await mkdtemp(join(tmpdir(), 'felan-log-tail-'));
  temporaryPaths.push(root);
  const runtime = new HostAgentRuntime(root, {
    sessionStorageRoot: root,
    agentStorageRoot: root,
  });
  const storage = runtime.storage('session');
  const path = join(root, name);
  await storage.writeFile(path, new TextEncoder().encode(content));
  const readFile = vi.spyOn(storage, 'readFile');
  const shell = vi.spyOn(runtime, 'shell');
  return { path, readFile, shell, tail: (lines: number) => readLogTail(runtime, storage, path, lines) };
}
