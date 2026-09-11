import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { SessionManager, type ModelRuntime } from '@felan-ai/agent-core';
import type { AgentContext } from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NodeAcpLoginTerminal,
  runLocalFelanAcpLogin,
  type AcpLoginChoice,
  type AcpLoginTerminal,
} from '../src/acp/login.js';
import { AcpSessionRegistry } from '../src/acp/session-registry.js';
import { createLocalModelRuntime, type LocalFelanRuntime } from '../src/runtime.js';

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => (
    rm(path, { force: true, recursive: true })
  )));
});

describe('finite ACP terminal login', () => {
  it('selects a provider method, hides API-key input, and waits for synchronized login', async () => {
    const secret = 'sk-test-secret-12345678';
    const terminal = new TestLoginTerminal([0], [secret]);
    const errors: string[] = [];
    const login = vi.fn(async (_providerId, _type, interaction) => {
      const key = await interaction.prompt({ type: 'secret', message: 'Enter API key' });
      interaction.notify({ type: 'progress', message: `Checking ${key}` });
      return { type: 'api_key' as const, key };
    });

    const exitCode = await runLocalFelanAcpLogin({
      terminal,
      signalSource: new EventEmitter(),
      createModelRuntime: async () => modelRuntime({
        provider: {
          id: 'provider',
          name: 'Provider',
          auth: { apiKey: { name: 'API key', login: vi.fn() } },
        },
        login,
      }),
      writeError: (message) => errors.push(message),
    });

    expect(exitCode).toBe(0);
    expect(login).toHaveBeenCalledWith('provider', 'api_key', expect.objectContaining({
      signal: expect.any(AbortSignal),
      prompt: expect.any(Function),
      notify: expect.any(Function),
    }));
    expect(terminal.inputRequests).toEqual([{
      message: 'Enter API key',
      options: { secret: true },
    }]);
    expect(terminal.lines.join('\n')).not.toContain(secret);
    expect(terminal.lines.join('\n')).toContain('[REDACTED_SECRET]');
    expect(terminal.lines).toContain('Authentication saved for Provider.');
    expect(errors).toEqual([]);
  });

  it('handles OAuth URLs, device codes, selections, and manual codes without leaking input', async () => {
    const manualCode = 'manual-secret-code';
    const terminal = new TestLoginTerminal([0, 1], [manualCode]);
    const login = vi.fn(async (_providerId, _type, interaction) => {
      interaction.notify({
        type: 'auth_url',
        url: 'https://auth.example/login?state=keep&token=remove-me',
        instructions: 'Continue in your browser',
      });
      interaction.notify({
        type: 'device_code',
        userCode: 'DEVICE-CODE',
        verificationUri: 'https://auth.example/device',
      });
      const region = await interaction.prompt({
        type: 'select',
        message: 'Choose account',
        options: [
          { id: 'first', label: 'First' },
          { id: 'second', label: 'Second' },
        ],
      });
      const code = await interaction.prompt({
        type: 'manual_code',
        message: 'Paste authorization code',
      });
      interaction.notify({ type: 'progress', message: `Exchanging ${code}` });
      return {
        type: 'oauth' as const,
        access: 'access',
        refresh: region,
        expires: Date.now() + 60_000,
      };
    });

    const exitCode = await runLocalFelanAcpLogin({
      terminal,
      signalSource: new EventEmitter(),
      createModelRuntime: async () => modelRuntime({
        provider: {
          id: 'oauth-provider',
          name: 'OAuth Provider',
          auth: {
            oauth: {
              name: 'OAuth',
              login: vi.fn(),
              refresh: vi.fn(),
              toAuth: vi.fn(),
            },
          },
        },
        login,
      }),
    });

    expect(exitCode).toBe(0);
    expect(login).toHaveBeenCalledWith('oauth-provider', 'oauth', expect.any(Object));
    expect(terminal.inputRequests).toEqual([{
      message: 'Paste authorization code',
      options: { secret: true },
    }]);
    const output = terminal.lines.join('\n');
    expect(output).toContain('state=keep');
    expect(output).toContain('token=%5BREDACTED%5D');
    expect(output).toContain('Device code: DEVICE-CODE');
    expect(output).not.toContain(manualCode);
    expect(output).toContain('[REDACTED_SECRET]');
  });

  it('redacts a rejected credential from login failures', async () => {
    const secret = 'unstructured credential value';
    const terminal = new TestLoginTerminal([0], [secret]);
    const errors: string[] = [];

    const exitCode = await runLocalFelanAcpLogin({
      terminal,
      signalSource: new EventEmitter(),
      createModelRuntime: async () => modelRuntime({
        provider: {
          id: 'provider',
          name: 'Provider',
          auth: { apiKey: { name: 'API key', login: vi.fn() } },
        },
        login: vi.fn(async (_providerId, _type, interaction) => {
          const key = await interaction.prompt({ type: 'secret', message: 'Enter API key' });
          throw new Error(`Provider rejected ${key}`);
        }),
      }),
      writeError: (message) => errors.push(message),
    });

    expect(exitCode).toBe(1);
    expect(terminal.lines.join('\n')).not.toContain(secret);
    expect(errors.join('\n')).not.toContain(secret);
    expect(errors).toEqual(['Authentication failed: Provider rejected [REDACTED_SECRET]']);
  });

  it('persists through ModelRuntime.login and authenticates a fresh ACP registry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'felan-acp-login-'));
    temporaryPaths.push(root);
    const agentDir = join(root, 'agent');
    const cwd = join(root, 'workspace');
    await Promise.all([mkdir(agentDir), mkdir(cwd)]);
    const secret = 'test-anthropic-key';
    const output: string[] = [];
    const terminal: AcpLoginTerminal = {
      select: async (_message, options) => options.find((option) => (
        option.label.includes('(anthropic)') && option.description?.startsWith('API key')
      ))?.id,
      input: async (_message, options) => options.secret ? secret : undefined,
      writeLine: (message) => output.push(message),
    };

    await expect(runLocalFelanAcpLogin({
      agentDir,
      terminal,
      signalSource: new EventEmitter(),
    })).resolves.toBe(0);
    expect(output.join('\n')).not.toContain(secret);
    expect(JSON.parse(await readFile(join(agentDir, 'auth.json'), 'utf8'))).toMatchObject({
      anthropic: { type: 'api_key', key: secret },
    });

    const freshRuntime = await createLocalModelRuntime(agentDir);
    expect(freshRuntime.hasConfiguredAuth('anthropic')).toBe(true);

    const dispose = vi.fn(async () => {});
    const registry = new AcpSessionRegistry({
      agentDir,
      createRuntime: async ({ cwd: runtimeCwd }) => ({
        diagnostics: [],
        session: {
          sessionManager: SessionManager.inMemory(runtimeCwd!, { id: 'authenticated-session' }),
          bindExtensions: vi.fn(async () => {}),
          abort: vi.fn(async () => {}),
        },
        dispose,
      }) as unknown as LocalFelanRuntime,
    });

    await expect(registry.newSession({
      cwd,
      mcpServers: [],
    }, {} as AgentContext)).resolves.toEqual({ sessionId: 'authenticated-session' });
    await registry.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('returns nonzero on user cancellation and process signals', async () => {
    const cancelledTerminal = new TestLoginTerminal([undefined], []);
    const login = vi.fn();
    expect(await runLocalFelanAcpLogin({
      terminal: cancelledTerminal,
      signalSource: new EventEmitter(),
      createModelRuntime: async () => modelRuntime({
        provider: {
          id: 'provider',
          name: 'Provider',
          auth: { apiKey: { name: 'API key', login: vi.fn() } },
        },
        login,
      }),
    })).toBe(1);
    expect(login).not.toHaveBeenCalled();
    expect(cancelledTerminal.lines).toContain('Authentication cancelled.');

    let promptCancellationSignal: AbortSignal | undefined;
    expect(await runLocalFelanAcpLogin({
      terminal: new TestLoginTerminal([0], []),
      signalSource: new EventEmitter(),
      createModelRuntime: async () => modelRuntime({
        provider: {
          id: 'provider',
          name: 'Provider',
          auth: { apiKey: { name: 'API key', login: vi.fn() } },
        },
        login: vi.fn(async (_providerId, _type, interaction) => {
          promptCancellationSignal = interaction.signal;
          await interaction.prompt({ type: 'secret', message: 'Enter API key' });
          return { type: 'api_key' as const, key: 'unused' };
        }),
      }),
    })).toBe(1);
    expect(promptCancellationSignal?.aborted).toBe(true);

    const signalSource = new EventEmitter();
    let loginSignal: AbortSignal | undefined;
    let lateInteraction: Parameters<ModelRuntime['login']>[2] | undefined;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const signalledTerminal = new TestLoginTerminal([0], []);
    const terminateProcess = vi.fn();
    const signalled = runLocalFelanAcpLogin({
      terminal: signalledTerminal,
      signalSource,
      terminateProcess,
      createModelRuntime: async () => modelRuntime({
        provider: {
          id: 'provider',
          name: 'Provider',
          auth: { apiKey: { name: 'API key', login: vi.fn() } },
        },
        login: vi.fn(async (_providerId, _type, interaction) => {
          loginSignal = interaction.signal;
          lateInteraction = interaction;
          markStarted();
          await new Promise<void>(() => {});
          return { type: 'api_key' as const, key: 'unused' };
        }),
      }),
    });
    await started;
    signalSource.emit('SIGTERM');

    await expect(signalled).resolves.toBe(143);
    await vi.waitFor(() => expect(terminateProcess).toHaveBeenCalledExactlyOnceWith(143));
    expect(loginSignal?.aborted).toBe(true);
    expect(signalSource.listenerCount('SIGINT')).toBe(0);
    expect(signalSource.listenerCount('SIGTERM')).toBe(0);
    const lineCount = signalledTerminal.lines.length;
    lateInteraction?.notify({ type: 'progress', message: 'late secret output' });
    expect(signalledTerminal.lines).toHaveLength(lineCount);
    await expect(lateInteraction?.prompt({
      type: 'secret',
      message: 'late prompt',
    })).rejects.toThrow('Authentication cancelled');
  });

  it('does not echo raw secret input and restores terminal mode', async () => {
    const input = new PassThrough() as PassThrough & {
      isTTY: true;
      isRaw: boolean;
      setRawMode(mode: boolean): typeof input;
    };
    input.isTTY = true;
    input.isRaw = false;
    const rawModes: boolean[] = [];
    input.setRawMode = (mode) => {
      rawModes.push(mode);
      input.isRaw = mode;
      return input;
    };
    const output = new PassThrough();
    let rendered = '';
    output.on('data', (chunk) => { rendered += chunk.toString(); });
    const terminal = new NodeAcpLoginTerminal(
      input as unknown as NodeJS.ReadStream,
      output as unknown as NodeJS.WriteStream,
    );

    const answer = terminal.input('Secret', { secret: true }, new AbortController().signal);
    input.emit('keypress', 'hidden-value', { name: 'h' });
    input.emit('keypress', '\r', { name: 'return' });

    await expect(answer).resolves.toBe('hidden-value');
    expect(rendered).toBe('Secret: \n');
    expect(rawModes).toEqual([true, false]);
    expect(input.isPaused()).toBe(true);

    const closingInput = new PassThrough() as PassThrough & {
      isTTY: true;
      isRaw: boolean;
      setRawMode(mode: boolean): typeof closingInput;
    };
    closingInput.isTTY = true;
    closingInput.isRaw = false;
    const closingRawModes: boolean[] = [];
    closingInput.setRawMode = (mode) => {
      closingRawModes.push(mode);
      closingInput.isRaw = mode;
      return closingInput;
    };
    const closingTerminal = new NodeAcpLoginTerminal(
      closingInput as unknown as NodeJS.ReadStream,
      new PassThrough() as unknown as NodeJS.WriteStream,
    );
    const closedAnswer = closingTerminal.input(
      'Secret',
      { secret: true },
      new AbortController().signal,
    );
    closingInput.emit('close');

    await expect(closedAnswer).resolves.toBeUndefined();
    expect(closingRawModes).toEqual([true, false]);
    expect(closingInput.isPaused()).toBe(true);
  });

  it('rejects visible terminal input before buffering an oversized line', async () => {
    const input = new PassThrough();
    const terminal = new NodeAcpLoginTerminal(
      input as unknown as NodeJS.ReadStream,
      new PassThrough() as unknown as NodeJS.WriteStream,
    );
    const selected = terminal.select(
      'Choose',
      [{ id: 'one', label: 'One' }],
      new AbortController().signal,
    );
    input.write(Buffer.alloc(64 * 1024 + 1, 97));

    await expect(selected).rejects.toThrow('Terminal input exceeds the maximum size');
    expect(input.isPaused()).toBe(true);
  });

  it('preserves typeahead following a visible line terminator', async () => {
    const input = new PassThrough();
    const terminal = new NodeAcpLoginTerminal(
      input as unknown as NodeJS.ReadStream,
      new PassThrough() as unknown as NodeJS.WriteStream,
    );
    const selected = terminal.select(
      'Choose',
      [{ id: 'one', label: 'One' }],
      new AbortController().signal,
    );
    input.write('1\r\nnext answer\n');

    await expect(selected).resolves.toBe('one');
    await expect(terminal.input(
      'Question',
      { secret: false },
      new AbortController().signal,
    )).resolves.toBe('next answer');
  });
});

class TestLoginTerminal implements AcpLoginTerminal {
  readonly lines: string[] = [];
  readonly inputRequests: Array<{
    readonly message: string;
    readonly options: { readonly secret: boolean; readonly placeholder?: string };
  }> = [];
  readonly #selectionIndexes: Array<number | undefined>;
  readonly #answers: string[];

  constructor(selectionIndexes: Array<number | undefined>, answers: string[]) {
    this.#selectionIndexes = [...selectionIndexes];
    this.#answers = [...answers];
  }

  async select(
    _message: string,
    options: readonly AcpLoginChoice[],
    _signal: AbortSignal,
  ): Promise<string | undefined> {
    const index = this.#selectionIndexes.shift();
    return index === undefined ? undefined : options[index]?.id;
  }

  async input(
    message: string,
    options: { readonly secret: boolean; readonly placeholder?: string },
    _signal: AbortSignal,
  ): Promise<string | undefined> {
    this.inputRequests.push({ message, options });
    return this.#answers.shift();
  }

  writeLine(message: string): void {
    this.lines.push(message);
  }
}

function modelRuntime(options: {
  readonly provider: unknown;
  readonly login: ReturnType<typeof vi.fn>;
}): ModelRuntime {
  return {
    getProviders: () => [options.provider],
    hasConfiguredAuth: () => false,
    login: options.login,
  } as unknown as ModelRuntime;
}
