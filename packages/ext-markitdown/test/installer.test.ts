import type {
  AgentRuntime,
  AgentRuntimeStorage,
  ExecOptions,
  ExecResult,
} from '@felan-ai/agent-core';
import { describe, expect, it, vi } from 'vitest';
import {
  detectMarkitdown,
  installManagedMarkitdown,
  managedVenvDirectory,
  MARKITDOWN_VERSION,
} from '../src/installer.js';

describe('MarkItDown installation', () => {
  it('prefers a compatible managed environment and falls back to PATH', async () => {
    const managed = runtime((command, args) => (
      isManagedCommand(command) && (args.join(' ') === '-m markitdown --version' || args.includes('-o'))
        ? success(`markitdown ${MARKITDOWN_VERSION}`)
        : failure('not found')
    ));
    await expect(detectMarkitdown(managed.runtime)).resolves.toMatchObject({
      available: true,
      invocation: { source: 'managed', version: MARKITDOWN_VERSION },
    });
    expect(managed.exec).toHaveBeenCalledWith(
      expect.stringMatching(/markitdown[\\/]venv/u),
      ['-m', 'markitdown', '--version'],
      expect.objectContaining({ timeout: 60_000 }),
    );

    const path = runtime((command, args) => (
      command === 'markitdown' && (args.join(' ') === '--version' || args.includes('-o'))
        ? success(`markitdown ${MARKITDOWN_VERSION}`)
        : failure('not found')
    ));
    await expect(detectMarkitdown(path.runtime)).resolves.toMatchObject({
      available: true,
      invocation: { source: 'path', version: MARKITDOWN_VERSION },
    });
    expect(path.exec).toHaveBeenCalledWith(
      'markitdown',
      ['--version'],
      expect.objectContaining({ timeout: 60_000 }),
    );
  });

  it('rejects an exact-version installation whose PDF extra is missing', async () => {
    const fixture = runtime((command, args) => {
      if (isManagedCommand(command) && args.join(' ') === '-m markitdown --version') {
        return success(`markitdown ${MARKITDOWN_VERSION}`);
      }
      if (isManagedCommand(command) && args.includes('-o')) return failure('PDF converter dependency is missing');
      return failure('not found');
    });

    const detected = await detectMarkitdown(fixture.runtime);

    expect(detected).toMatchObject({ available: false });
    if (!detected.available) expect(detected.reason).toContain('/markitdown install');
    expect(fixture.exec).toHaveBeenCalledWith(
      expect.stringMatching(/markitdown[\\/]venv/u),
      expect.arrayContaining(['-o']),
      expect.objectContaining({ maxOutputBytes: 64 * 1024, timeout: 60_000 }),
    );
  });

  it('rejects missing and obsolete commands with explicit installation guidance', async () => {
    const fixture = runtime((command, args) => (
      command === 'markitdown' && args.at(-1) === '--version'
        ? success('markitdown 0.0.2')
        : failure('not found')
    ));
    const detected = await detectMarkitdown(fixture.runtime);
    expect(detected).toMatchObject({ available: false });
    if (!detected.available) expect(detected.reason).toContain('/markitdown install');
  });

  it('creates a managed venv and installs the pinned document extras only after explicit invocation', async () => {
    let venvCreated = false;
    let installed = false;
    const fixture = runtime((command, args, options) => {
      const joined = args.join(' ');
      if (command === 'python3' && joined === '--version') return success('Python 3.12.4');
      if (command === 'python3' && args.slice(0, 2).join(' ') === '-m venv') {
        venvCreated = true;
        return success('');
      }
      if (isManagedCommand(command) && joined === '--version') {
        return venvCreated ? success('Python 3.12.4') : failure('not found');
      }
      if (isManagedCommand(command) && joined.includes('-m pip install')) {
        installed = true;
        return success('');
      }
      if (isManagedCommand(command) && joined === '-m markitdown --version') {
        return installed && options?.timeout === 60_000
          ? success(`markitdown ${MARKITDOWN_VERSION}`)
          : killed();
      }
      if (isManagedCommand(command) && args.includes('-o')) {
        return installed ? success('') : failure('PDF converter dependency is missing');
      }
      return failure('not found');
    });
    const statuses: string[] = [];
    const result = await installManagedMarkitdown(fixture.runtime, (status) => statuses.push(status));

    expect(result).toMatchObject({
      available: true,
      invocation: { source: 'managed', version: MARKITDOWN_VERSION },
    });
    expect(fixture.storage.mkdir).toHaveBeenCalledWith('markitdown', { recursive: true });
    expect(fixture.exec).toHaveBeenCalledWith(
      'python3',
      ['-m', 'venv', managedVenvDirectory(fixture.runtime)],
      expect.objectContaining({ timeout: 60_000 }),
    );
    expect(fixture.exec).toHaveBeenCalledWith(
      'python3',
      ['--version'],
      expect.objectContaining({ timeout: 10_000 }),
    );
    const pipCall = fixture.exec.mock.calls.find(([, args]) => (args as readonly string[]).includes('pip'));
    expect(pipCall?.[1]).toContain(`markitdown[pdf,docx,pptx,xlsx,xls,outlook]==${MARKITDOWN_VERSION}`);
    expect(pipCall?.[1]).not.toContain('all');
    expect(pipCall?.[2]).toMatchObject({ maxOutputBytes: 64 * 1024 });
    const verificationCall = fixture.exec.mock.calls.find(([, args]) => (
      (args as readonly string[]).join(' ') === '-m markitdown --version'
    ));
    expect(verificationCall?.[2]).toMatchObject({ timeout: 60_000 });
    expect(statuses).toEqual(expect.arrayContaining([
      'Finding Python 3.10 or newer...',
      `Installing MarkItDown ${MARKITDOWN_VERSION} document support...`,
      'Verifying the managed MarkItDown environment...',
    ]));
  });

  it('reports Python and pip failures without throwing raw process output', async () => {
    const noPython = runtime(() => failure('missing\u0000python'));
    await expect(installManagedMarkitdown(noPython.runtime, () => {})).resolves.toEqual({
      available: false,
      reason: 'Python 3.10 or newer was not found on PATH; MarkItDown was not installed.',
    });
  });

  it('keeps an unresponsive CLI probe bounded', async () => {
    const fixture = runtime(() => killed());
    await expect(detectMarkitdown(fixture.runtime)).resolves.toMatchObject({ available: false });
    expect(fixture.exec).toHaveBeenCalledTimes(2);
    for (const [, , options] of fixture.exec.mock.calls) {
      expect(options).toMatchObject({ maxOutputBytes: 64 * 1024, timeout: 60_000 });
    }
  });
});

function runtime(handler: (
  command: string,
  args: readonly string[],
  options?: ExecOptions,
) => ExecResult) {
  const files = new Map<string, Uint8Array>();
  const storage: AgentRuntimeStorage = {
    root: '/agent-storage',
    readFile: vi.fn(async (path: string) => {
      const value = files.get(path);
      if (!value) throw new Error('not found');
      return value;
    }),
    writeFile: vi.fn(async (path: string, content: Uint8Array | string) => {
      files.set(path, typeof content === 'string' ? new TextEncoder().encode(content) : Uint8Array.from(content));
    }),
    listFiles: vi.fn(),
    mkdir: vi.fn(),
    remove: vi.fn(async (path: string) => {
      files.delete(path);
    }),
  };
  const exec = vi.fn(async (command: string, args: readonly string[], options?: ExecOptions) => {
    const result = handler(command, args, options);
    const outputIndex = args.indexOf('-o');
    if (result.code === 0 && !result.killed && outputIndex >= 0) {
      const outputPath = args[outputIndex + 1]!;
      const relativePath = outputPath.replace(/^[/\\]agent-storage[/\\]?/u, '').replaceAll('\\', '/');
      files.set(relativePath, new TextEncoder().encode('Felan MarkItDown PDF probe\n'));
    }
    return result;
  });
  const unused = async (): Promise<never> => { throw new Error('unused'); };
  const agentRuntime: AgentRuntime = {
    kind: 'host',
    cwd: '/workspace',
    storage: () => storage,
    exec,
    shell: unused,
    readFile: unused,
    writeFile: unused,
    listFiles: unused,
    mkdir: unused,
    remove: unused,
  };
  return { runtime: agentRuntime, storage, exec };
}

function success(stdout: string): ExecResult {
  return { stdout, stderr: '', code: 0, killed: false };
}

function failure(stderr: string): ExecResult {
  return { stdout: '', stderr, code: 1, killed: false };
}

function killed(): ExecResult {
  return { stdout: '', stderr: '', code: 143, killed: true };
}

function isManagedCommand(command: string): boolean {
  return /markitdown[\\/]venv/u.test(command);
}
