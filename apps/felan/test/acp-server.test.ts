import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { DAEMON_VERSION } from '@felan-ai/daemon';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runLocalFelanAcp } from '../src/acp/server.js';
import { FELAN_VERSION } from '../src/version.js';
import { acpDaemonFixture } from './acp-daemon-fixture.js';
import { gate } from '../../daemon/test/fixtures/server.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

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

  it.each([['EOF', 0], ['SIGTERM', 143]] as const)('detaches on %s without cancelling daemon execution', async (closing, code) => {
    const stream = gate();
    const f = await acpDaemonFixture({ onStream: () => stream.promise });
    cleanups.push(() => f.dispose());
    cleanups.push(async () => stream.resolve());
    const input = new PassThrough();
    const output = new PassThrough();
    const diagnostics = new PassThrough();
    const signalSource = new EventEmitter();
    const running = runLocalFelanAcp({ input, output, diagnostics, signalSource, createClient: f.createClient });
    let response = nextLine(output);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })}\n`);
    await response;
    response = nextLine(output);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/load', params: { sessionId: f.root.sessionId, cwd: f.cwd, mcpServers: [] } })}\n`);
    await response;
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: f.root.sessionId, prompt: [{ type: 'text', text: 'keep running' }] } })}\n`);
    await vi.waitFor(() => expect(f.store.session(f.root.sessionId).run.state).toBe('running'));
    if (closing === 'EOF') input.end(); else signalSource.emit('SIGTERM');
    await expect(running).resolves.toBe(code);
    expect(f.store.session(f.root.sessionId).run.state).toBe('running');
    expect(f.store.session(f.root.sessionId).state).toBe('open');
    expect(signalSource.listenerCount('SIGINT')).toBe(0);
    expect(signalSource.listenerCount('SIGTERM')).toBe(0);
    stream.resolve();
  });

  it('reports an attached daemon build mismatch to diagnostics without blocking ACP work or contaminating stdout', async () => {
    const f = await acpDaemonFixture();
    cleanups.push(() => f.dispose());
    const input = new PassThrough();
    const output = new PassThrough();
    const diagnostics = new PassThrough();
    const outputChunks: Buffer[] = [];
    const diagnosticChunks: Buffer[] = [];
    output.on('data', (chunk: Buffer) => outputChunks.push(Buffer.from(chunk)));
    diagnostics.on('data', (chunk: Buffer) => diagnosticChunks.push(Buffer.from(chunk)));
    const createClient: typeof f.createClient = options => f.createClient({ ...options, expectedDaemonVersion: 'next-build' });
    const running = runLocalFelanAcp({ input, output, diagnostics, daemonRuntime: '/tmp/acp runtime', createClient });
    const responses = () => Buffer.concat(outputChunks).toString('utf8').trimEnd().split('\n').filter(Boolean).map(line => JSON.parse(line) as { id?: number; result?: unknown });

    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })}\n`);
    await vi.waitFor(() => expect(responses().find(response => response.id === 1)).toMatchObject({ result: { protocolVersion: 1 } }));
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/load', params: { sessionId: f.root.sessionId, cwd: f.cwd, mcpServers: [] } })}\n`);
    await vi.waitFor(() => expect(responses().find(response => response.id === 2)).toMatchObject({ result: {} }));
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: f.root.sessionId, prompt: [{ type: 'text', text: 'hello' }] } })}\n`);
    await vi.waitFor(() => expect(responses().find(response => response.id === 3)).toMatchObject({ result: { stopReason: 'end_turn' } }));

    input.end();
    await expect(running).resolves.toBe(0);
    const stdout = Buffer.concat(outputChunks).toString('utf8');
    expect(() => stdout.trimEnd().split('\n').filter(Boolean).map(line => JSON.parse(line))).not.toThrow();
    expect(stdout).not.toContain('Daemon ');
    expect(Buffer.concat(diagnosticChunks).toString('utf8')).toBe(
      `Daemon ${DAEMON_VERSION} is running; this installation expects next-build. Run felan daemon restart --daemon-runtime '/tmp/acp runtime' to apply the new build.\n`,
    );
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

