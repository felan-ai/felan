import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { SessionManager, type ModelRuntime } from '@felan-ai/agent-core';
import { describe, expect, it, vi } from 'vitest';
import { runLocalFelanAcp } from '../src/acp/server.js';
import { FELAN_VERSION } from '../src/version.js';
import type { LocalFelanRuntime } from '../src/runtime.js';

function nextLine(stream: PassThrough): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffered = '';
    const onData = (chunk: Buffer) => {
      buffered += chunk.toString();
      const newline = buffered.indexOf('\n');
      if (newline < 0) return;
      cleanup();
      resolve(buffered.slice(0, newline));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      stream.off('data', onData);
      stream.off('error', onError);
    };
    stream.on('data', onData);
    stream.on('error', onError);
  });
}

describe('ACP server', () => {
  it('negotiates stable v1 and exits cleanly when stdin closes', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const diagnostics = new PassThrough();
    const responseLine = nextLine(output);
    const running = runLocalFelanAcp({ input, output, diagnostics });

    input.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: 999,
        clientCapabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' },
      },
    })}\n`);

    const response = JSON.parse(await responseLine) as Record<string, any>;
    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: 1,
        agentCapabilities: {},
        agentInfo: { name: 'felan', title: 'Felan Code', version: FELAN_VERSION },
      },
    });
    expect(response.result?.authMethods).toBeUndefined();

    input.end();
    await expect(running).resolves.toBe(0);
    expect(diagnostics.readableLength).toBe(0);
  });

  it('accepts the registry validator terminal-auth capability without contaminating stdout', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const diagnostics = new PassThrough();
    const outputChunks: Buffer[] = [];
    output.on('data', (chunk: Buffer) => outputChunks.push(Buffer.from(chunk)));
    const responseLine = nextLine(output);
    const running = runLocalFelanAcp({ input, output, diagnostics });

    input.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: 1,
        clientInfo: { name: 'ACP Registry Validator', version: '1.0.0' },
        clientCapabilities: {
          terminal: true,
          fs: { readTextFile: true, writeTextFile: true },
          _meta: { terminal_output: true, 'terminal-auth': true },
        },
      },
    })}\n`);

    const response = JSON.parse(await responseLine) as Record<string, any>;
    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: 1,
        agentInfo: { name: 'felan', title: 'Felan Code', version: FELAN_VERSION },
        authMethods: [{
          id: 'felan-terminal-login',
          name: 'Log in to Felan Code',
          type: 'terminal',
          args: ['login'],
        }],
      },
    });

    input.end();
    await expect(running).resolves.toBe(0);
    const stdout = Buffer.concat(outputChunks).toString('utf8');
    const lines = stdout.endsWith('\n') ? stdout.slice(0, -1).split('\n') : [];
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ jsonrpc: '2.0', id: 1 });
    expect(diagnostics.readableLength).toBe(0);
  });

  it('closes sessions and returns the conventional code on a termination signal', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const diagnostics = new PassThrough();
    const signalSource = new EventEmitter();
    const abort = vi.fn(async () => {});
    const dispose = vi.fn(async () => {});
    const bindExtensions = vi.fn(async () => {});
    const running = runLocalFelanAcp({
      input,
      output,
      diagnostics,
      signalSource,
      createModelRuntime: async () => authenticatedModelRuntime(),
      createRuntime: async ({ cwd }) => ({
        diagnostics: [],
        session: {
          sessionManager: SessionManager.inMemory(cwd, { id: 'signal-session' }),
          bindExtensions,
          abort,
        },
        dispose,
      }) as unknown as LocalFelanRuntime,
    });

    let responseLine = nextLine(output);
    input.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' },
      },
    })}\n`);
    await responseLine;

    responseLine = nextLine(output);
    input.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
      params: { cwd: process.cwd(), mcpServers: [] },
    })}\n`);
    await responseLine;

    signalSource.emit('SIGTERM');
    await expect(running).resolves.toBe(143);
    expect(abort).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(signalSource.listenerCount('SIGINT')).toBe(0);
    expect(signalSource.listenerCount('SIGTERM')).toBe(0);
    expect(diagnostics.readableLength).toBe(0);
  });

  it('aborts and joins an active prompt when stdin disconnects', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const diagnostics = new PassThrough();
    let releasePrompt: (() => void) | undefined;
    const prompt = vi.fn(async () => new Promise<void>((resolve) => { releasePrompt = resolve; }));
    const abort = vi.fn(async () => { releasePrompt?.(); });
    const dispose = vi.fn(async () => {});
    const running = runLocalFelanAcp({
      input,
      output,
      diagnostics,
      createModelRuntime: async () => authenticatedModelRuntime(),
      createRuntime: async ({ cwd }) => ({
        diagnostics: [],
        session: {
          sessionManager: SessionManager.inMemory(cwd, { id: 'disconnect-session' }),
          bindExtensions: vi.fn(async () => {}),
          subscribe: vi.fn(() => () => {}),
          prompt,
          abort,
        },
        dispose,
      }) as unknown as LocalFelanRuntime,
    });

    let responseLine = nextLine(output);
    input.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: 1, clientCapabilities: {} },
    })}\n`);
    await responseLine;
    responseLine = nextLine(output);
    input.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
      params: { cwd: process.cwd(), mcpServers: [] },
    })}\n`);
    await responseLine;
    input.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/prompt',
      params: {
        sessionId: 'disconnect-session',
        prompt: [{ type: 'text', text: 'keep running' }],
      },
    })}\n`);
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());

    input.end();
    await expect(running).resolves.toBe(0);
    expect(abort).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(diagnostics.readableLength).toBe(0);
  });

  it('redacts secrets from ACP startup failures', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const diagnostics = new PassThrough();
    const options = { input, output, diagnostics };
    Object.defineProperty(options, 'agentDir', {
      enumerable: true,
      get: () => { throw new Error('startup failed with sk-packed-secret-12345678'); },
    });

    await expect(runLocalFelanAcp(options)).resolves.toBe(1);
    const reported = diagnostics.read()?.toString() ?? '';
    expect(reported).not.toContain('sk-packed-secret-12345678');
    expect(reported).toContain('[REDACTED_TOKEN]');
  });
});

function authenticatedModelRuntime(): ModelRuntime {
  return {
    getProviders: () => [{ id: 'test-provider' }],
    hasConfiguredAuth: () => true,
  } as unknown as ModelRuntime;
}
